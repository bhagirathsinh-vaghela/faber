import path from "path"
import { lazy } from "../util/lazy"
import { Storage } from "./storage"
import { Db } from "./db"
import type { MessageV2 } from "../session/message-v2"

// Session parts are the streaming hot path: one part is rewritten from every
// delta of a token stream, and N active sessions multiply that into a storm of
// whole-file rewrites + renames + inode churn that starves a slow disk. They
// are also mutable and individually deletable after creation (a tool part goes
// pending → running → completed; revert deletes specific parts), so an
// append-only log cannot back them. Held in SQLite (WAL) via the shared Db:
// row-level upsert/delete, readers never blocking the writer, no per-write fsync.
export namespace Parts {
  const open = lazy(async () => {
    const db = await Db.open()
    // session_id mirrors upstream's PartTable: it lets a whole session's parts be
    // deleted in one statement, which is what Session.remove needs. Its index also
    // matches upstream (part_session_idx). The PK stays (message_id, id) WITHOUT
    // ROWID so per-message reads are a contiguous clustered range scan.
    db.run(`
      CREATE TABLE IF NOT EXISTS part (
        id         TEXT NOT NULL,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        json       TEXT NOT NULL,
        length     INTEGER NOT NULL,
        PRIMARY KEY (message_id, id)
      ) WITHOUT ROWID
    `)
    db.run(`CREATE INDEX IF NOT EXISTS part_session_idx ON part (session_id)`)
    return {
      // Bun caches prepared queries in an LRU capped at 20, so hold explicit
      // references rather than re-preparing per call.
      put: db.query<void, [string, string, string, string, number]>(
        `INSERT INTO part (id, message_id, session_id, json, length) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(message_id, id) DO UPDATE SET json = excluded.json, length = excluded.length`,
      ),
      // Migration insert: never clobber a row the live binary already wrote for
      // this key. `changes` tells the caller whether the row was new (for counts).
      importRow: db.query<void, [string, string, string, string, number]>(
        `INSERT OR IGNORE INTO part (id, message_id, session_id, json, length) VALUES (?, ?, ?, ?, ?)`,
      ),
      db,
      // Part ids render their time field as fixed-width zero-padded hex, so
      // BINARY collation + id ASC reproduces the file backend's `a.id > b.id`
      // sort exactly, index-backed by the PK.
      list: db.query<{ json: string; length: number }, [string]>(
        `SELECT json, length FROM part WHERE message_id = ? ORDER BY id ASC`,
      ),
      one: db.query<{ json: string }, [string, string]>(`SELECT json FROM part WHERE message_id = ? AND id = ?`),
      remove: db.query<void, [string, string]>(`DELETE FROM part WHERE message_id = ? AND id = ?`),
      removeMessage: db.query<void, [string]>(`DELETE FROM part WHERE message_id = ?`),
      removeSession: db.query<void, [string]>(`DELETE FROM part WHERE session_id = ?`),
    }
  })

  export async function put(part: MessageV2.Part) {
    const json = JSON.stringify(part)
    await open().then((q) => q.put.run(part.id, part.messageID, part.sessionID, json, Buffer.byteLength(json)))
  }

  // The byte total the message cache budgets on, summed here so the caller does
  // not re-serialize every part to measure it.
  export async function list(messageID: string) {
    const rows = await open().then((q) => q.list.all(messageID))
    const parts = [] as MessageV2.Part[]
    let size = 0
    for (const row of rows) {
      // A corrupt blob drops only that part, matching the file backend's guard
      // against a torn file. A torn row cannot exist in SQLite.
      const parsed = tryParse(row.json)
      if (!parsed) continue
      parts.push(parsed)
      size += row.length
    }
    return { parts, size }
  }

  export async function one(messageID: string, partID: string) {
    const row = await open().then((q) => q.one.get(messageID, partID))
    if (!row) throw new Storage.NotFoundError({ message: `Part not found: ${messageID}/${partID}` })
    return JSON.parse(row.json) as MessageV2.Part
  }

  export async function remove(messageID: string, partID: string) {
    await open().then((q) => q.remove.run(messageID, partID))
  }

  export async function removeMessage(messageID: string) {
    await open().then((q) => q.removeMessage.run(messageID))
  }

  export async function removeSession(sessionID: string) {
    await open().then((q) => q.removeSession.run(sessionID))
  }

  // The prepared DELETE, so Session.remove can drop parts, messages, and the
  // session row in one transaction instead of three awaits a crash can interleave.
  export async function removeSessionQuery() {
    return open().then((q) => q.removeSession)
  }

  const MIGRATE_CHUNK = 5000

  // Import the legacy `part/<messageID>/<partID>.json` tree into the table. Run
  // with the server DOWN so no concurrent write races the glob — quiescence is
  // the correctness guarantee, not a lock. Idempotent via INSERT OR IGNORE on the
  // PK, so a second run (or a crash-and-rerun) inserts nothing new. Non-
  // destructive: the JSON files are left in place for rollback. Returns counts.
  export async function migrate() {
    const dir = await Storage.ready().then((x) => x.dir)
    const q = await open()
    let scanned = 0
    let readable = 0
    let inserted = 0
    // Insert in bounded transactions rather than one giant one: a large store
    // can have ~272k part files, some ~280KB, so accumulating every row in
    // memory before a single commit would hold gigabytes at once. A chunk is one
    // fsync; INSERT OR IGNORE keeps the whole run idempotent across chunk
    // boundaries.
    const flush = q.db.transaction(
      (rows: { id: string; messageID: string; sessionID: string; json: string; length: number }[]) => {
        for (const row of rows) {
          if (q.importRow.run(row.id, row.messageID, row.sessionID, row.json, row.length).changes > 0) inserted++
        }
      },
    )
    let batch = [] as { id: string; messageID: string; sessionID: string; json: string; length: number }[]
    const glob = new Bun.Glob("part/*/*.json")
    for await (const entry of glob.scan({ cwd: dir, onlyFiles: true })) {
      scanned++
      // The part's own id/messageID come from the file body, not the path, so a
      // renamed file can't desync the row's keys.
      const part = (await Bun.file(path.join(dir, entry)).json().catch(() => undefined)) as MessageV2.Part | undefined
      // Skip a part missing any NOT NULL key: one such file must not abort the
      // whole chunk transaction on a 272k-file import.
      if (!part?.id || !part.messageID || !part.sessionID) continue
      readable++
      const json = JSON.stringify(part)
      batch.push({ id: part.id, messageID: part.messageID, sessionID: part.sessionID, json, length: Buffer.byteLength(json) })
      if (batch.length >= MIGRATE_CHUNK) {
        flush(batch)
        batch = []
      }
    }
    if (batch.length) flush(batch)
    return { scanned, inserted, skipped: readable - inserted, unreadable: scanned - readable }
  }

  function tryParse(json: string): MessageV2.Part | undefined {
    try {
      return JSON.parse(json) as MessageV2.Part
    } catch {
      return undefined
    }
  }
}
