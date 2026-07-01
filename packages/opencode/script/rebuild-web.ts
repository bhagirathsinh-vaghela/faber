#!/usr/bin/env bun
// One-command UI rebuild loop: repack packages/app into the embedded bundle,
// then tell the running server to reload it from disk. No process restart, so
// this only covers web-UI changes (packages/app) — server-code changes still
// need a real restart. Port defaults to 4097 (the dev serve port); override
// with the first arg or OPENCODE_PORT.

import path from "path"
import { $ } from "bun"

const port = process.argv[2] ?? process.env["OPENCODE_PORT"] ?? "4097"

await $`bun run ${path.resolve(import.meta.dir, "pack-web.ts")}`

const res = await fetch(`http://127.0.0.1:${port}/global/web/reload`, { method: "POST" })
if (!res.ok) throw new Error(`reload failed: server at port ${port} returned ${res.status} ${await res.text()}`)

const { assets } = (await res.json()) as { assets: number }
console.log(`Reloaded ${assets} web assets on port ${port} — hard-reload the browser to pick them up.`)
