import { createHash } from "crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import photonWasm from "@silvia-odwyer/photon-node/photon_rs_bg.wasm" with { type: "file" }
import { Log } from "@/util/log"

export namespace Image {
  const log = Log.create({ service: "image" })

  // Above 20 images per request Anthropic caps every image at 2000px on its
  // long edge, which binds well before the 8000px ceiling and before Opus
  // 4.7's 2576px high-resolution tier.
  export const MAX_WIDTH = 2000
  export const MAX_HEIGHT = 2000
  // The direct API allows 10MB per image; Bedrock and Vertex allow 5MB.
  export const MAX_BASE64_BYTES = 10 * 1024 * 1024

  // Visual tokens are ceil(w/28) * ceil(h/28) — a function of dimensions
  // alone — so re-encoding is free to the model and buys only wire bytes.
  // q92 measured as the knee on real screenshots: below it glyph-edge error
  // climbs faster than bytes fall, above it bytes climb for little gain.
  // Candidates are tried in order and the first under budget wins, so the
  // ladder must descend or later rungs are unreachable.
  const JPEG_QUALITIES = [92, 85, 75, 60]
  const SHRINK_STEPS = 32
  const SHRINK_FACTOR = 0.75
  const CACHE_LIMIT = 256

  export type Limits = {
    maxWidth: number
    maxHeight: number
    maxBase64Bytes: number
  }

  const DEFAULT_LIMITS: Limits = {
    maxWidth: MAX_WIDTH,
    maxHeight: MAX_HEIGHT,
    maxBase64Bytes: MAX_BASE64_BYTES,
  }

  export type Normalized =
    | { status: "unchanged" }
    | { status: "resized"; mime: string; base64: string; width: number; height: number }
    | { status: "oversized"; width: number; height: number; bytes: number }
    | { status: "undecodable" }
    | { status: "unavailable" }

  type Photon = typeof import("@silvia-odwyer/photon-node")

  let photonPromise: Promise<Photon> | undefined

  // Bun's compiled binary bakes __dirname to the build machine's path, so
  // photon's own `join(__dirname, ...wasm)` resolves to a file that does not
  // exist on any other machine. The patched module reads this global instead.
  function loadPhoton(): Promise<Photon> {
    photonPromise ??= (async () => {
      const wasmPath = path.isAbsolute(photonWasm) ? photonWasm : fileURLToPath(new URL(photonWasm, import.meta.url))
      ;(globalThis as typeof globalThis & { __OPENCODE_PHOTON_WASM_PATH?: string }).__OPENCODE_PHOTON_WASM_PATH =
        wasmPath
      return import("@silvia-odwyer/photon-node")
    })()
    return photonPromise
  }

  // Resizing costs ~260ms per image, and history is replayed on every request,
  // so an uncached clamp would add seconds per turn once a session accumulates
  // screenshots.
  const cache = new Map<string, Normalized>()

  function remember(key: string, outcome: Normalized) {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!)
    cache.set(key, outcome)
    return outcome
  }

  // PNG and JPEG both carry their dimensions near the start of the file, so a
  // prefix is enough. Anything else (WebP, GIF, a truncated header) returns
  // undefined and falls through to a full decode.
  const HEADER_PREFIX_CHARS = 4 * 1024

  function readHeaderSize(base64: string) {
    let header: Buffer
    try {
      header = Buffer.from(base64.slice(0, HEADER_PREFIX_CHARS), "base64")
    } catch {
      return undefined
    }

    if (header.length >= 24 && header.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
      return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }

    if (header.length < 4 || header[0] !== 0xff || header[1] !== 0xd8) return undefined
    let cursor = 2
    while (cursor + 9 < header.length) {
      if (header[cursor] !== 0xff) {
        cursor++
        continue
      }
      const marker = header[cursor + 1]!
      // SOF0-SOF3 and SOF5-SOF7 / SOF9-SOF11 carry the frame dimensions; DHT,
      // DAC and RST are not frame headers despite sitting in the same range.
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb))
        return { width: header.readUInt16BE(cursor + 7), height: header.readUInt16BE(cursor + 5) }
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        cursor += 2
        continue
      }
      if (marker === 0x01 || marker === 0xff) {
        cursor++
        continue
      }
      cursor += 2 + header.readUInt16BE(cursor + 2)
    }
    return undefined
  }

  function shrinkSizes(width: number, height: number, limits: Limits) {
    const scale = Math.min(1, limits.maxWidth / width, limits.maxHeight / height)
    const sizes: Array<{ width: number; height: number }> = []
    let current = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
    for (let step = 0; step < SHRINK_STEPS; step++) {
      if (sizes.some((size) => size.width === current.width && size.height === current.height)) break
      sizes.push(current)
      if (current.width === 1 && current.height === 1) break
      current = {
        width: Math.max(1, Math.floor(current.width * SHRINK_FACTOR)),
        height: Math.max(1, Math.floor(current.height * SHRINK_FACTOR)),
      }
    }
    return sizes
  }

  export async function normalize(base64: string, limits: Limits = DEFAULT_LIMITS): Promise<Normalized> {
    const bytes = Buffer.byteLength(base64, "utf8")

    // Decoding costs ~16ms against ~0.3ms to read a header, and most images in
    // a replayed history are already compliant. Reading the dimensions out of
    // the container lets those skip the decode entirely.
    const declared = readHeaderSize(base64)
    if (
      declared &&
      declared.width <= limits.maxWidth &&
      declared.height <= limits.maxHeight &&
      bytes <= limits.maxBase64Bytes
    )
      return { status: "unchanged" }

    const key = createHash("sha256")
      .update(`${limits.maxWidth}x${limits.maxHeight}:${limits.maxBase64Bytes}:`)
      .update(base64)
      .digest("hex")
    const cached = cache.get(key)
    if (cached) return cached

    let photon: Photon
    try {
      photon = await loadPhoton()
    } catch (error) {
      log.warn("failed to load photon", { error })
      return { status: "unavailable" }
    }

    let decoded: InstanceType<Photon["PhotonImage"]>
    try {
      decoded = photon.PhotonImage.new_from_byteslice(Buffer.from(base64, "base64"))
    } catch (error) {
      log.warn("failed to decode image", { error })
      return remember(key, { status: "undecodable" })
    }

    try {
      const width = decoded.get_width()
      const height = decoded.get_height()
      if (width <= limits.maxWidth && height <= limits.maxHeight && bytes <= limits.maxBase64Bytes)
        return remember(key, { status: "unchanged" })

      for (const size of shrinkSizes(width, height, limits)) {
        const resized = photon.resize(decoded, size.width, size.height, photon.SamplingFilter.Lanczos3)
        try {
          const candidates = JPEG_QUALITIES.map((quality) => ({
            mime: "image/jpeg",
            data: Buffer.from(resized.get_bytes_jpeg(quality)).toString("base64"),
          }))
          const fitting = candidates.find((candidate) => Buffer.byteLength(candidate.data, "utf8") <= limits.maxBase64Bytes)
          if (fitting) {
            log.info("resized image", {
              from: `${width}x${height}`,
              to: `${size.width}x${size.height}`,
              mime: fitting.mime,
            })
            return remember(key, {
              status: "resized",
              mime: fitting.mime,
              base64: fitting.data,
              width: size.width,
              height: size.height,
            })
          }
        } finally {
          resized.free()
        }
      }

      log.warn("could not resize image below limits", { width, height, bytes })
      return remember(key, { status: "oversized", width, height, bytes })
    } finally {
      decoded.free()
    }
  }

  // Clamps every image part in place, before the message is persisted. Doing
  // it here rather than at send time is what keeps a stored part byte-stable
  // for the rest of the session: replaying history re-sends identical bytes,
  // so the cached prefix never moves and no marker is invalidated.
  export async function clamp(parts: Array<{ type: string; mime?: string; url?: string }>) {
    for (const part of parts) {
      if (part.type !== "file" || !part.mime?.startsWith("image/")) continue
      const marker = ";base64,"
      const at = part.url?.indexOf(marker) ?? -1
      if (at === -1) continue

      const outcome = await normalize(part.url!.slice(at + marker.length))
      if (outcome.status === "resized") {
        part.mime = outcome.mime
        part.url = `data:${outcome.mime};base64,${outcome.base64}`
        continue
      }
      if (outcome.status === "oversized")
        log.warn("image exceeds provider limits and could not be resized", {
          width: outcome.width,
          height: outcome.height,
        })
    }
  }

  export function reset() {
    cache.clear()
  }

  export const headerSize = readHeaderSize

  export function cacheSize() {
    return cache.size
  }
}
