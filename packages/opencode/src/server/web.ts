import assets from "./web-assets.json" with { type: "json" }

// Decode the embedded web bundle once at startup into an in-memory map. The
// bundle is produced by script/pack-web.ts from packages/app/dist.
const decoded = new Map<string, { type: string; body: Uint8Array }>()
for (const [path, asset] of Object.entries(assets as Record<string, { type: string; body: string }>)) {
  decoded.set(path, { type: asset.type, body: Buffer.from(asset.body, "base64") })
}

const index = decoded.get("/index.html")

export namespace Web {
  export const available = decoded.size > 0 && !!index

  // Serves the embedded SPA: exact asset by path, else index.html fallback so
  // client-side routes resolve. Returns null if no bundle is embedded.
  export function serve(path: string): Response | null {
    if (!index) return null
    const hit = decoded.get(path === "/" ? "/index.html" : path)
    const asset = hit ?? index
    return new Response(asset.body, {
      headers: {
        "Content-Type": asset.type,
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' data:",
      },
    })
  }
}
