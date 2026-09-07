import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "fs/promises"
import os from "os"
import path from "path"

// A signal is the only stop the process sees coming, so it is the one chance to
// fold the WAL back into the database. Driven through a child process rather
// than by calling Db.close directly, because what is being asserted is the
// state left ON DISK for the next process — the same thing the supervisor's
// next server opens after a /restart.

let dir: string
let db: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-shutdown-"))
  db = path.join(dir, "t.db")
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

// Db.close's shape, against a fixture path: checkpoint TRUNCATE, then close.
const CLOSE = `
  try { db.run("PRAGMA wal_checkpoint(TRUNCATE)") } catch {}
  db.close()
`

async function child(body: string) {
  const file = path.join(dir, "child.ts")
  await Bun.write(
    file,
    `import { Database } from "bun:sqlite"
     const db = new Database(process.argv[2])
     db.run("PRAGMA busy_timeout = 15000")
     if (db.query("PRAGMA journal_mode").get().journal_mode !== "wal") db.run("PRAGMA journal_mode = WAL")
     db.run("PRAGMA synchronous = NORMAL")
     db.run("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)")
     const put = db.query("INSERT INTO t (v) VALUES (?)")
     for (let i = 0; i < 2000; i++) put.run("row-" + i)
     ${body}`,
  )
  const proc = Bun.spawn(["bun", "run", file, db], { stdout: "pipe", stderr: "pipe" })
  await proc.exited
  return proc
}

const walBytes = () =>
  fs
    .stat(db + "-wal")
    .then((s) => s.size)
    .catch(() => 0)

describe("Db.close", () => {
  test("checkpointing on shutdown leaves no WAL for the next process to recover", async () => {
    await child(CLOSE)
    // TRUNCATE folds every frame back and zeroes the file, so the next open
    // finds nothing to replay.
    expect(await walBytes()).toBe(0)
    // The rows survived the checkpoint, which is the point of folding them in
    // rather than discarding them.
    const next = new Database(db)
    expect(next.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM t").get()!.n).toBe(2000)
    next.close()
  }, 30_000)

  test("exiting without the checkpoint leaves a WAL behind", async () => {
    // The contrast case, which is what a process that just dies produces. If
    // this ever stops leaving a WAL, the test above proves nothing.
    await child("")
    expect(await walBytes()).toBeGreaterThan(0)
  }, 30_000)
})
