import embedded from "./web-assets.json" with { type: "json" }
import path from "path"

type Encoded = Record<string, { type: string; body: string; br?: string; gzip?: string }>

type Asset = { type: string; body: Uint8Array; br?: Uint8Array; gzip?: Uint8Array }

// The embedded bundle (produced by script/pack-web.ts from packages/app/dist)
// is what makes the binary self-contained. reload() overlays a fresh read of
// web-assets.json from disk onto the same Map, so a rebuilt UI goes live
// without restarting the process. Same serving path in both cases.
const decoded = new Map<string, Asset>()

function fill(assets: Encoded) {
  decoded.clear()
  for (const [file, asset] of Object.entries(assets))
    decoded.set(file, {
      type: asset.type,
      body: Buffer.from(asset.body, "base64"),
      br: asset.br ? Buffer.from(asset.br, "base64") : undefined,
      gzip: asset.gzip ? Buffer.from(asset.gzip, "base64") : undefined,
    })
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
  // client-side routes resolve. Returns null if no bundle is embedded. Serves the
  // brotli/gzip variant packed at build time when the client accepts it.
  export function serve(file: string, accept?: string): Response | null {
    const index = decoded.get("/index.html")
    if (!index) return null
    const asset = decoded.get(file === "/" ? "/index.html" : file) ?? index
    const encoding =
      asset.br && accept?.includes("br") ? "br" : asset.gzip && accept?.includes("gzip") ? "gzip" : undefined
    const body = encoding === "br" ? asset.br! : encoding === "gzip" ? asset.gzip! : asset.body
    // Vite content-hashes /assets/* filenames, so their bytes never change for a
    // given URL — cache them forever. Everything else (index.html fallback) must
    // revalidate so a rebuilt UI is picked up.
    const hashed = asset !== index && file.startsWith("/assets/")
    const headers: Record<string, string> = {
      "Content-Type": asset.type,
      "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
      Vary: "Accept-Encoding",
      // worker-src/script-src blob: for the dictation AudioWorklet, which loads
      // its module from an inline Blob URL.
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' data:",
    }
    if (encoding) headers["Content-Encoding"] = encoding
    return new Response(body, { headers })
  }
}
