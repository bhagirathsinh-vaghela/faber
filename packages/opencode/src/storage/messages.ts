import path from "path"
import { lazy } from "../util/lazy"
import { Storage } from "./storage"
import { Db } from "./db"
import type { MessageV2 } from "../session/message-v2"

// Messages, stored as a JSON blob keyed by id, with session_id + time_created
// lifted into columns (the fields the reads order and scan by). A facade over
// the shared Db that reproduces the `Storage` semantics the session code relies
// on — reconcile (read-modify-write, first-write yields undefined), readSized
// (value + byte length for the message cache budget), and a per-session ordered
// list — so the caller's reconcile/preserveTerminal/broadcast logic is unchanged.
export namespace Messages {
  const open = lazy(async () => {
    const db = await Db.open()
    db.run(`
      CREATE TABLE IF NOT EXISTS message (
        id           TEXT NOT NULL PRIMARY KEY,
        session_id   TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        json         TEXT NOT NULL,
        length       INTEGER NOT NULL
      )
    `)
    // The list read orders a session's messages by (time_created, id); the same
    // index upstream keeps on its message table.
    db.run(`CREATE INDEX IF NOT EXISTS message_session_time_idx ON message (session_id, time_created, id)`)
    return {
      get: db.query<{ json: string; length: number }, [string]>(`SELECT json, length FROM message WHERE id = ?`),
      put: db.query<void, [string, string, number, string, number]>(
        `INSERT INTO message (id, session_id, time_created, json, length) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, time_created = excluded.time_created,
           json = excluded.json, length = excluded.length`,
      ),
      importRow: db.query<void, [string, string, number, string, number]>(
        `INSERT OR IGNORE INTO message (id, session_id, time_created, json, length) VALUES (?, ?, ?, ?, ?)`,
      ),
      listSession: db.query<{ id: string }, [string]>(
        `SELECT id FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC`,
      ),
      remove: db.query<void, [string]>(`DELETE FROM message WHERE id = ?`),
      removeSession: db.query<void, [string]>(`DELETE FROM message WHERE session_id = ?`),
      db,
    }
  })

  function created(message: MessageV2.Info) {
    return message.time.created
  }

  export async function put(message: MessageV2.Info) {
    const json = JSON.stringify(message)
    await open().then((q) => q.put.run(message.id, message.sessionID, created(message), json, Buffer.byteLength(json)))
  }

  // Read-modify-write under the DB's own atomicity. `merge` sees the stored
  // message or undefined (first write), matching Storage.reconcile.
  export async function reconcile(messageID: string, merge: (stored: MessageV2.Info | undefined) => MessageV2.Info) {
    const q = await open()
    const row = q.get.get(messageID)
    const stored = row ? (JSON.parse(row.json) as MessageV2.Info) : undefined
    const merged = merge(stored)
    const json = JSON.stringify(merged)
    q.put.run(merged.id, merged.sessionID, created(merged), json, Buffer.byteLength(json))
    return merged
  }

  // Value plus its stored byte length, which the message cache budgets on.
  export async function readSized(messageID: string) {
    const row = await open().then((q) => q.get.get(messageID))
    if (!row) throw new Storage.NotFoundError({ message: `Message not found: ${messageID}` })
    return { value: JSON.parse(row.json) as MessageV2.Info, size: row.length }
  }

  export async function read(messageID: string) {
    return readSized(messageID).then((x) => x.value)
  }

  // A session's message ids, ordered as the transcript reads them.
  export async function listSession(sessionID: string) {
    const rows = await open().then((q) => q.listSession.all(sessionID))
    return rows.map((r) => r.id)
  }

  export async function remove(messageID: string) {
    await open().then((q) => q.remove.run(messageID))
  }

  export async function removeSession(sessionID: string) {
    await open().then((q) => q.removeSession.run(sessionID))
  }

  export async function removeSessionQuery() {
    return open().then((q) => q.removeSession)
  }

  // Import the legacy `message/<sessionID>/<messageID>.json` tree into the table.
  // Same contract as Parts.migrate: server DOWN, INSERT OR IGNORE (idempotent),
  // non-destructive. Returns { scanned, inserted }.
  export async function migrate() {
    const dir = await Storage.ready().then((x) => x.dir)
    const q = await open()
    let scanned = 0
    let inserted = 0
    const flush = q.db.transaction((rows: MessageV2.Info[]) => {
      for (const m of rows) {
        const json = JSON.stringify(m)
        if (q.importRow.run(m.id, m.sessionID, created(m), json, Buffer.byteLength(json)).changes > 0) inserted++
      }
    })
    let batch = [] as MessageV2.Info[]
    for await (const entry of new Bun.Glob("message/*/*.json").scan({ cwd: dir, onlyFiles: true })) {
      scanned++
      const m = (await Bun.file(path.join(dir, entry)).json().catch(() => undefined)) as MessageV2.Info | undefined
      if (!m?.id || !m.sessionID || !m.time?.created) continue
      batch.push(m)
      if (batch.length >= 5000) {
        flush(batch)
        batch = []
      }
    }
    if (batch.length) flush(batch)
    return { scanned, inserted }
  }
}
