import embedded from "./web-assets.json" with { type: "json" }
import path from "path"

type Encoded = Record<string, { type: string; body: string }>

// The embedded bundle (produced by script/pack-web.ts from packages/app/dist)
// is what makes the binary self-contained. reload() overlays a fresh read of
// web-assets.json from disk onto the same Map, so a rebuilt UI goes live
// without restarting the process. Same serving path in both cases.
const decoded = new Map<string, { type: string; body: Uint8Array }>()

function fill(assets: Encoded) {
  decoded.clear()
  for (const [file, asset] of Object.entries(assets))
    decoded.set(file, { type: asset.type, body: Buffer.from(asset.body, "base64") })
}

fill(embedded as Encoded)

export namespace Web {
  export function available() {
    return decoded.size > 0 && decoded.has("/index.html")
  }

  export async function reload() {
    const assets = (await Bun.file(path.resolve(import.meta.dir, "web-assets.json")).json()) as Encoded
    fill(assets)
    return decoded.size
  }

  // Serves the embedded SPA: exact asset by path, else index.html fallback so
  // client-side routes resolve. Returns null if no bundle is embedded.
  export function serve(file: string): Response | null {
    const index = decoded.get("/index.html")
    if (!index) return null
    const asset = decoded.get(file === "/" ? "/index.html" : file) ?? index
    return new Response(asset.body, {
      headers: {
        "Content-Type": asset.type,
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' data:",
      },
    })
  }
}
