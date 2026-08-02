import { afterEach, describe, expect, test } from "bun:test"
import { compress } from "./image"

// happy-dom implements neither createImageBitmap nor real canvas encoding, so
// the browser surface compress() drives is stubbed. The pixels are not the
// point: the branch that decides whether to re-encode is.
type Scenario = {
  width: number
  height: number
  encodedBytes?: number
  contextAvailable?: boolean
}

const realCreateImageBitmap = globalThis.createImageBitmap
const realToBlob = HTMLCanvasElement.prototype.toBlob
const realGetContext = HTMLCanvasElement.prototype.getContext

let closed = 0
let drawnTo: Array<{ width: number; height: number }> = []
let qualitiesTried: number[] = []

function browser(scenario: Scenario) {
  closed = 0
  drawnTo = []
  qualitiesTried = []

  globalThis.createImageBitmap = (async () => ({
    width: scenario.width,
    height: scenario.height,
    close: () => {
      closed++
    },
  })) as unknown as typeof createImageBitmap

  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string) {
    if (kind !== "2d") return null
    if (scenario.contextAvailable === false) return null
    return {
      fillStyle: "",
      fillRect: () => {},
      drawImage: () => drawnTo.push({ width: this.width, height: this.height }),
    } as unknown as CanvasRenderingContext2D
  } as typeof HTMLCanvasElement.prototype.getContext

  HTMLCanvasElement.prototype.toBlob = function (callback, _mime, quality) {
    qualitiesTried.push(quality as number)
    callback(new Blob([new Uint8Array(scenario.encodedBytes ?? 10_000)], { type: "image/jpeg" }))
  } as typeof HTMLCanvasElement.prototype.toBlob
}

function sourceFile(bytes: number, name = "shot.png", type = "image/png") {
  return new File([new Uint8Array(bytes)], name, { type })
}

afterEach(() => {
  globalThis.createImageBitmap = realCreateImageBitmap
  HTMLCanvasElement.prototype.toBlob = realToBlob
  HTMLCanvasElement.prototype.getContext = realGetContext
})

describe("compress", () => {
  test("clamps a small-byte image that exceeds the dimension limit", async () => {
    browser({ width: 3680, height: 2266 })
    const source = sourceFile(823_012)

    const result = await compress(source)

    expect(result).not.toBe(source)
    expect(result.type).toBe("image/jpeg")
    expect(drawnTo).toEqual([{ width: 2000, height: 1232 }])
  })

  test("re-encodes a compliant image to shed bytes", async () => {
    browser({ width: 1200, height: 800, encodedBytes: 90_000 })
    const source = sourceFile(300_000)

    const result = await compress(source)

    expect(result).not.toBe(source)
    expect(drawnTo).toEqual([{ width: 1200, height: 800 }])
  })

  test("keeps the original when re-encoding would not shrink it", async () => {
    browser({ width: 400, height: 300, encodedBytes: 60_000 })
    const source = sourceFile(20_000)

    expect(await compress(source)).toBe(source)
  })

  test("encodes at the measured quality knee", async () => {
    browser({ width: 3000, height: 1000 })

    await compress(sourceFile(500_000))

    expect(qualitiesTried).toEqual([0.92])
  })

  test("encodes exactly once, with no quality ladder", async () => {
    browser({ width: 3000, height: 1000, encodedBytes: 9_000_000 })

    await compress(sourceFile(500_000))

    expect(qualitiesTried.length).toBe(1)
  })

  test("clamps the longest edge when height is the overflowing side", async () => {
    browser({ width: 900, height: 4500 })

    await compress(sourceFile(200_000))

    expect(drawnTo).toEqual([{ width: 400, height: 2000 }])
  })

  test("preserves aspect ratio while clamping", async () => {
    browser({ width: 4000, height: 1000 })

    await compress(sourceFile(200_000))

    expect(drawnTo).toEqual([{ width: 2000, height: 500 }])
  })

  test("leaves an image exactly at the dimension limit at its own size", async () => {
    browser({ width: 2000, height: 2000 })

    await compress(sourceFile(500_000))

    expect(drawnTo).toEqual([{ width: 2000, height: 2000 }])
  })

  test("clamps an image one pixel over the dimension limit", async () => {
    browser({ width: 2001, height: 100 })

    await compress(sourceFile(500_000))

    expect(drawnTo).toEqual([{ width: 2000, height: 100 }])
  })

  test("names the re-encoded file with a jpg extension", async () => {
    browser({ width: 3000, height: 1000 })

    expect((await compress(sourceFile(200_000, "Screenshot 2026-08-02.png"))).name).toBe("Screenshot 2026-08-02.jpg")
  })

  test("releases the bitmap after re-encoding", async () => {
    browser({ width: 3000, height: 1000 })

    await compress(sourceFile(200_000))

    expect(closed).toBe(1)
  })

  test("releases the bitmap and returns the original when no 2d context exists", async () => {
    browser({ width: 3000, height: 1000, contextAvailable: false })
    const source = sourceFile(200_000)

    expect(await compress(source)).toBe(source)
    expect(closed).toBe(1)
  })
})
