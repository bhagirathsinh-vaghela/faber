import { describe, expect, test, beforeEach } from "bun:test"
import { Image } from "../../src/image/image"

const photon = await import("@silvia-odwyer/photon-node")

function solid(width: number, height: number) {
  const pixels = new Uint8Array(width * height * 4)
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = index % 251
    pixels[index + 1] = (index >> 3) % 251
    pixels[index + 2] = (index >> 5) % 251
    pixels[index + 3] = 255
  }
  return new photon.PhotonImage(pixels, width, height)
}

function pngBase64(width: number, height: number) {
  const image = solid(width, height)
  const encoded = Buffer.from(image.get_bytes()).toString("base64")
  image.free()
  return encoded
}

function dimensionsOf(base64: string) {
  const decoded = photon.PhotonImage.new_from_byteslice(Buffer.from(base64, "base64"))
  const size = { width: decoded.get_width(), height: decoded.get_height() }
  decoded.free()
  return size
}

beforeEach(() => Image.reset())

describe("Image.normalize", () => {
  test("leaves an image inside both limits untouched", async () => {
    expect(await Image.normalize(pngBase64(64, 64))).toEqual({ status: "unchanged" })
  })

  test("resizes an image that fits the byte limit but exceeds the width limit", async () => {
    const outcome = await Image.normalize(pngBase64(2_400, 100))

    expect(outcome.status).toBe("resized")
    if (outcome.status !== "resized") return
    expect(outcome.width).toBeLessThanOrEqual(Image.MAX_WIDTH)
    expect(dimensionsOf(outcome.base64).width).toBeLessThanOrEqual(Image.MAX_WIDTH)
  })

  test("resizes an image that exceeds the height limit", async () => {
    const outcome = await Image.normalize(pngBase64(100, 2_400))

    expect(outcome.status).toBe("resized")
    if (outcome.status !== "resized") return
    expect(outcome.height).toBeLessThanOrEqual(Image.MAX_HEIGHT)
    expect(dimensionsOf(outcome.base64).height).toBeLessThanOrEqual(Image.MAX_HEIGHT)
  })

  test("preserves aspect ratio when clamping", async () => {
    const outcome = await Image.normalize(pngBase64(4_000, 1_000))

    expect(outcome.status).toBe("resized")
    if (outcome.status !== "resized") return
    expect(outcome.width).toBe(2_000)
    expect(outcome.height).toBe(500)
  })

  test("clamps the longest edge when both dimensions exceed the limit", async () => {
    const outcome = await Image.normalize(pngBase64(3_000, 2_500))

    expect(outcome.status).toBe("resized")
    if (outcome.status !== "resized") return
    expect(Math.max(outcome.width, outcome.height)).toBe(2_000)
  })

  test("reports an undecodable payload rather than throwing", async () => {
    expect(await Image.normalize(Buffer.from("not an image").toString("base64"))).toEqual({ status: "undecodable" })
  })

  test("re-encodes to jpeg so the wire payload shrinks", async () => {
    const outcome = await Image.normalize(pngBase64(2_400, 1_200))

    expect(outcome.status).toBe("resized")
    if (outcome.status !== "resized") return
    expect(outcome.mime).toBe("image/jpeg")
  })

  test("emits a smaller payload than the lossless source", async () => {
    const source = pngBase64(2_400, 1_200)
    const outcome = await Image.normalize(source)

    expect(outcome.status).toBe("resized")
    if (outcome.status !== "resized") return
    expect(Buffer.byteLength(outcome.base64, "utf8")).toBeLessThan(Buffer.byteLength(source, "utf8"))
  })

  test("reports oversized when no candidate fits the byte budget", async () => {
    const outcome = await Image.normalize(pngBase64(2_400, 100), {
      maxWidth: Image.MAX_WIDTH,
      maxHeight: Image.MAX_HEIGHT,
      maxBase64Bytes: 1,
    })

    expect(outcome.status).toBe("oversized")
  })

  test("shrinks past the dimension limit to satisfy a tight byte budget", async () => {
    const outcome = await Image.normalize(pngBase64(2_400, 2_400), {
      maxWidth: Image.MAX_WIDTH,
      maxHeight: Image.MAX_HEIGHT,
      maxBase64Bytes: 20_000,
    })

    expect(outcome.status).toBe("resized")
    if (outcome.status !== "resized") return
    expect(Buffer.byteLength(outcome.base64, "utf8")).toBeLessThanOrEqual(20_000)
    expect(outcome.width).toBeLessThan(Image.MAX_WIDTH)
  })

  test("is deterministic across repeated calls", async () => {
    const source = pngBase64(2_400, 1_200)
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => Image.normalize(source)))

    expect(new Set(outcomes.map((outcome) => JSON.stringify(outcome))).size).toBe(1)
  })

  test("serves a repeat call from cache", async () => {
    const source = pngBase64(2_400, 100)
    await Image.normalize(source)
    expect(Image.cacheSize()).toBe(1)

    await Image.normalize(source)
    expect(Image.cacheSize()).toBe(1)
  })

  test("caches per limit set so a different budget is recomputed", async () => {
    const source = pngBase64(2_400, 100)
    await Image.normalize(source)
    await Image.normalize(source, { maxWidth: 500, maxHeight: 500, maxBase64Bytes: Image.MAX_BASE64_BYTES })

    expect(Image.cacheSize()).toBe(2)
  })

  test("honours a lower explicit dimension limit", async () => {
    const outcome = await Image.normalize(pngBase64(1_000, 1_000), {
      maxWidth: 500,
      maxHeight: 500,
      maxBase64Bytes: Image.MAX_BASE64_BYTES,
    })

    expect(outcome.status).toBe("resized")
    if (outcome.status !== "resized") return
    expect(outcome.width).toBe(500)
  })

  test("normalizes a jpeg source as readily as a png", async () => {
    const image = solid(2_400, 100)
    const source = Buffer.from(image.get_bytes_jpeg(90)).toString("base64")
    image.free()

    const outcome = await Image.normalize(source)

    expect(outcome.status).toBe("resized")
    if (outcome.status !== "resized") return
    expect(dimensionsOf(outcome.base64).width).toBeLessThanOrEqual(Image.MAX_WIDTH)
  })

  test("evicts the oldest entry once the cache is full", async () => {
    for (let index = 0; index < 300; index++) await Image.normalize(pngBase64(8, 8 + index))
    expect(Image.cacheSize()).toBeLessThanOrEqual(256)
  })
})

// Clamping happens once, at ingest. A stored part must then stay byte-stable
// for the life of the session, because the provider's prompt cache is a
// prefix hash: rewriting any earlier byte invalidates every marker after it.
describe("Image.clamp", () => {
  const imagePart = (base64: string, mime = "image/png") => ({
    type: "file",
    mime,
    url: `data:${mime};base64,${base64}`,
  })

  test("clamps an oversized part in place", async () => {
    const parts = [imagePart(pngBase64(3_000, 1_200))]

    await Image.clamp(parts)

    const clamped = parts[0]!.url.slice(parts[0]!.url.indexOf(";base64,") + ";base64,".length)
    expect(Math.max(...Object.values(dimensionsOf(clamped)))).toBeLessThanOrEqual(Image.MAX_WIDTH)
    expect(parts[0]!.mime).toBe("image/jpeg")
  })

  test("is idempotent, so replaying history re-sends identical bytes", async () => {
    const parts = [imagePart(pngBase64(3_000, 1_200))]

    await Image.clamp(parts)
    const afterFirst = parts[0]!.url

    await Image.clamp(parts)

    expect(parts[0]!.url).toBe(afterFirst)
  })

  test("leaves a compliant part byte-identical", async () => {
    const parts = [imagePart(pngBase64(800, 600))]
    const original = parts[0]!.url

    await Image.clamp(parts)

    expect(parts[0]!.url).toBe(original)
  })

  test("leaves a non-image part untouched", async () => {
    const parts = [{ type: "file", mime: "application/pdf", url: "data:application/pdf;base64,JVBER" }]
    const original = parts[0]!.url

    await Image.clamp(parts)

    expect(parts[0]!.url).toBe(original)
  })

  test("leaves a text part untouched", async () => {
    const parts = [{ type: "text", url: undefined } as any]

    await Image.clamp(parts)

    expect(parts[0]!.url).toBeUndefined()
  })

  test("passes an undecodable payload through rather than dropping it", async () => {
    const parts = [imagePart(Buffer.from("not an image").toString("base64"))]
    const original = parts[0]!.url

    await Image.clamp(parts)

    expect(parts[0]!.url).toBe(original)
  })

  test("clamps every oversized part in one message", async () => {
    const parts = [imagePart(pngBase64(2_400, 900)), imagePart(pngBase64(3_200, 1_000)), imagePart(pngBase64(900, 800))]

    await Image.clamp(parts)

    for (const part of parts) {
      const base64 = part.url.slice(part.url.indexOf(";base64,") + ";base64,".length)
      expect(Math.max(...Object.values(dimensionsOf(base64)))).toBeLessThanOrEqual(Image.MAX_WIDTH)
    }
  })
})

// The fast-path lets a compliant image skip decoding, so a header that
// disagrees with the decoder would wave an oversized image through.
describe("Image.headerSize", () => {
  const shapes = [
    [64, 64],
    [2_400, 100],
    [100, 2_400],
    [1, 1],
    [4_000, 1_000],
    [2_000, 2_000],
    [2_001, 999],
  ] as const

  for (const [width, height] of shapes) {
    test(`agrees with the decoder for a ${width}x${height} png`, () => {
      expect(Image.headerSize(pngBase64(width, height))).toEqual({ width, height })
    })

    test(`agrees with the decoder for a ${width}x${height} jpeg`, () => {
      const image = solid(width, height)
      const source = Buffer.from(image.get_bytes_jpeg(90)).toString("base64")
      image.free()

      expect(Image.headerSize(source)).toEqual(dimensionsOf(source))
    })
  }

  test("returns undefined for a payload that is not an image", () => {
    expect(Image.headerSize(Buffer.from("not an image").toString("base64"))).toBeUndefined()
  })

  test("returns undefined for a truncated png header", () => {
    expect(Image.headerSize(pngBase64(64, 64).slice(0, 8))).toBeUndefined()
  })

  test("returns undefined rather than guessing for an unsupported container", () => {
    expect(Image.headerSize("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA")).toBeUndefined()
  })

  test("a header within limits reports unchanged without re-encoding", async () => {
    const source = pngBase64(1_000, 1_000)

    expect(await Image.normalize(source)).toEqual({ status: "unchanged" })
    expect(Image.cacheSize()).toBe(0)
  })
})
