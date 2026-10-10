import { describe, test, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { Storage } from "../../src/storage/storage"

describe("Storage", () => {
  test("write is readable immediately and leaves no temp file", async () => {
    const key = ["session", "test-project", "ses_writetest"]
    await Storage.write(key, { id: "ses_writetest", value: 42 })

    const read = await Storage.read<{ id: string; value: number }>(key)
    expect(read).toEqual({ id: "ses_writetest", value: 42 })

    const listed = await Storage.list(["session", "test-project"])
    // No entry decodes to a .tmp path; every listed key strips a real .json file.
    expect(listed.some((k) => k.some((seg) => seg.endsWith(".tmp")))).toBe(false)
    expect(listed).toContainEqual(["session", "test-project", "ses_writetest"])

    await Storage.remove(key)
  })

  describe("sweepOrphans", () => {
    test("reaps a .tmp older than the floor and keeps a fresh one", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-sweep-"))
      const stale = path.join(dir, "message", "ses_x", "msg_a.json.old.tmp")
      const fresh = path.join(dir, "message", "ses_x", "msg_b.json.new.tmp")
      await fs.mkdir(path.dirname(stale), { recursive: true })
      await Bun.write(stale, "stale")
      await Bun.write(fresh, "fresh")

      // Backdate the stale one well past the 15-day floor.
      const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000)
      await fs.utimes(stale, old, old)

      await Storage.sweepOrphans(dir)

      expect(await Bun.file(stale).exists()).toBe(false)
      expect(await Bun.file(fresh).exists()).toBe(true)

      await fs.rm(dir, { recursive: true, force: true })
    })

    test("never touches a real .json file", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-sweep-"))
      const json = path.join(dir, "message", "ses_x", "msg_a.json")
      await fs.mkdir(path.dirname(json), { recursive: true })
      await Bun.write(json, "{}")
      const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000)
      await fs.utimes(json, old, old)

      await Storage.sweepOrphans(dir)

      expect(await Bun.file(json).exists()).toBe(true)

      await fs.rm(dir, { recursive: true, force: true })
    })
  })
})

test("a failing migration leaves storage usable and is retried on the next boot", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-migrate-"))
  const storage = path.join(root, "share", "opencode", "storage")
  await Bun.write(path.join(storage, "migration"), "1")
  await Bun.write(path.join(storage, "session", "prj", "ses_bad.json"), "{bad")
  const entry = path.join(root, "boot.ts")
  await Bun.write(
    entry,
    `import { Storage } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/storage/storage"))}
await Storage.write(["probe"], { ok: true })
console.log(JSON.stringify(await Storage.read(["probe"])))`,
  )
  const env = Object.fromEntries(
    ["data", "cache", "config", "state"].map((kind) => [
      `XDG_${kind.toUpperCase()}_HOME`,
      path.join(root, kind === "data" ? "share" : kind),
    ]),
  )
  const proc = Bun.spawn(["bun", "run", entry], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
  const out = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  expect(out.trim().split("\n").at(-1)).toBe('{"ok":true}')
  expect(await Bun.file(path.join(storage, "migration")).text()).toBe("1")
  await fs.rm(root, { recursive: true, force: true })
})
