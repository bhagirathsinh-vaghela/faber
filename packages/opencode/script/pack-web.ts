#!/usr/bin/env bun
// Builds packages/app and packs its dist/ tree into a single JSON blob that the
// opencode binary embeds (via `import ... with { type: "json" }`) and serves
// in-memory. This is what makes the binary self-contained: it serves its own
// web UI with no dependency on app.opencode.ai.

import path from "path"
import fs from "fs"
import { $ } from "bun"

const dir = path.resolve(import.meta.dir, "..")
const appDir = path.resolve(dir, "../app")
const distDir = path.resolve(appDir, "dist")
const out = path.resolve(dir, "src/server/web-assets.json")

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
}

console.log("Building packages/app...")
await $`bun run build`.cwd(appDir)

if (!fs.existsSync(path.join(distDir, "index.html")))
  throw new Error(`pack-web: app build produced no index.html at ${distDir}`)

const assets: Record<string, { type: string; body: string }> = {}
const glob = new Bun.Glob("**/*")
for (const rel of glob.scanSync({ cwd: distDir, onlyFiles: true })) {
  const ext = path.extname(rel).toLowerCase()
  const web = "/" + rel.split(path.sep).join("/")
  assets[web] = {
    type: types[ext] ?? "application/octet-stream",
    body: Buffer.from(fs.readFileSync(path.join(distDir, rel))).toString("base64"),
  }
}

if (!assets["/index.html"]) throw new Error("pack-web: /index.html missing from packed assets")

await Bun.write(out, JSON.stringify(assets))
console.log(`Packed ${Object.keys(assets).length} web assets -> ${path.relative(dir, out)}`)
