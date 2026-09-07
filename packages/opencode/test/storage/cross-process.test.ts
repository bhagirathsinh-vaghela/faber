import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "fs/promises"
import os from "os"
import path from "path"

// Two OS PROCESSES against one database file, which is the only way to reach
// the concurrency this layer actually has to survive: bun:sqlite is
// synchronous, so statements issued inside a single process cannot interleave
// and an in-process test can never produce contention. A /restart runs a
// staging server beside the live one, so two writers on one file is ordinary
// operation rather than an edge case.
//
// These drive a temp database through the same statement shapes as the storage
// facades rather than importing them, because the facades resolve their path
// from Global and a child process must be pointed at the fixture.

let dir: string
let db: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-xproc-"))
  db = path.join(dir, "t.db")
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function child(source: string, ...args: string[]) {
  const file = path.join(dir, "child-" + Math.random().toString(36).slice(2) + ".ts")
  return Bun.write(file, source).then(() =>
    Bun.spawn(["bun", "run", file, db, ...args], { stdout: "pipe", stderr: "pipe" }),
  )
}

async function output(proc: Bun.Subprocess) {
  const [out, err] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()])
  await proc.exited
  return out.trim() + err.trim()
}

describe("cross-process storage", () => {
  test("a read-modify-write does not lose an update to a second process", async () => {
    new Database(db).run("PRAGMA journal_mode=WAL")
    const seed = new Database(db)
    seed.run("CREATE TABLE m (id TEXT PRIMARY KEY, json TEXT)")
    seed.run("INSERT INTO m VALUES ('x', ?)", [JSON.stringify({ n: 0 })])
    seed.close()

    // Messages.reconcile's shape: read the blob, mutate, write it back, inside
    // one IMMEDIATE transaction. The await between read and write is what a
    // second process slips through when the two statements are not one unit.
    const source = `
      import { Database } from "bun:sqlite"
      const db = new Database(process.argv[2])
      db.run("PRAGMA busy_timeout = 15000")
      const get = db.query("SELECT json FROM m WHERE id = 'x'")
      const put = db.query("INSERT INTO m VALUES ('x', ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json")
      const bump = db.transaction(() => {
        const stored = JSON.parse(get.get().json)
        stored.n += 1
        put.run(JSON.stringify(stored))
      })
      for (let i = 0; i < 150; i++) {
        for (let attempt = 0; ; attempt++) {
          try { bump.immediate(); break } catch (e) {
            if (!String(e.code).startsWith("SQLITE_BUSY") || attempt >= 5) throw e
            await Bun.sleep(25 * 2 ** attempt * (0.5 + Math.random()))
          }
        }
        await Bun.sleep(1)
      }
      console.log("done")
    `
    const [a, b] = await Promise.all([child(source), child(source)])
    const [ra, rb] = await Promise.all([output(a), output(b)])
    expect(ra).toBe("done")
    expect(rb).toBe("done")

    const read = new Database(db)
    // 300 increments, every one durable. Without the transaction both processes
    // read the same value and the later write discards the earlier increment —
    // silently, with both processes still reporting success.
    expect(JSON.parse(read.query<{ json: string }, []>("SELECT json FROM m WHERE id = 'x'").get()!.json).n).toBe(300)
    read.close()
  }, 30_000)

  test("opening concurrently sets busy_timeout before the statement that contends", async () => {
    // journal_mode takes an exclusive lock, so it is the open's contended
    // statement; with busy_timeout set first it waits rather than throwing.
    const source = `
      import { Database } from "bun:sqlite"
      try {
        const db = new Database(process.argv[2])
        db.run("PRAGMA busy_timeout = 15000")
        if (db.query("PRAGMA journal_mode").get().journal_mode !== "wal") db.run("PRAGMA journal_mode = WAL")
        db.run("PRAGMA synchronous = NORMAL")
        console.log("ok")
      } catch (e) { console.log("FAILED:" + e.code) }
    `
    const opens = await Promise.all(Array.from({ length: 8 }, () => child(source)))
    const results = await Promise.all(opens.map(output))
    expect(results.every((r) => r === "ok")).toBe(true)
  }, 30_000)
})
