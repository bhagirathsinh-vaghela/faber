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
  // When the session named by `column` was last prompted, as a scalar SQL
  // subquery: its newest user message that is not synthetic, not a compaction
  // request, and written since the session was created. The one definition,
  // shared by `reader().prompted` and Sessions' owed query, so the two can
  // never disagree. The creation bound leaves out context the agent tool
  // copies from the parent, which keeps the parent's older timestamps: until
  // the child's own prompt lands, it has not been prompted.
  export function prompts(column: string) {
    // Each json_extract sits behind a json_valid of its own row inside a CASE,
    // which SQLite evaluates in order: json_extract throws on a malformed
    // blob, and one torn row must not fail every session's query.
    return `(SELECT max(m.time_created) FROM message m
         WHERE m.session_id = ${column}
           AND m.time_created >= (SELECT time_created FROM session WHERE id = ${column})
           AND CASE WHEN json_valid(m.json) THEN json_extract(m.json, '$.role') = 'user' AND json_extract(m.json, '$.synthetic') IS NOT 1 END
           AND NOT EXISTS (SELECT 1 FROM part p WHERE p.message_id = m.id
             AND CASE WHEN json_valid(p.json) THEN json_extract(p.json, '$.type') = 'compaction' END))`
  }

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
      newest: db.query<{ json: string }, [string]>(
        `SELECT json FROM message WHERE session_id = ? ORDER BY id DESC LIMIT 1`,
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
    const q = await open()
    await Db.retry(() => q.put.run(message.id, message.sessionID, created(message), json, Buffer.byteLength(json)))
  }

  // Read-modify-write, with `merge` seeing the stored message or undefined
  // (first write), matching Storage.reconcile.
  //
  // The read and the write are ONE IMMEDIATE transaction. Issued as two
  // autocommit statements they are not atomic together, so a second process
  // (the staging server a /restart runs) committing between them makes this
  // write clobber a mutation it never saw. That loss is silent: both writers
  // report success and the earlier one's fields are simply gone.
  export async function reconcile(messageID: string, merge: (stored: MessageV2.Info | undefined) => MessageV2.Info) {
    const q = await open()
    let merged!: MessageV2.Info
    await Db.transaction(() => {
      const row = q.get.get(messageID)
      merged = merge(row ? (JSON.parse(row.json) as MessageV2.Info) : undefined)
      const json = JSON.stringify(merged)
      q.put.run(merged.id, merged.sessionID, created(merged), json, Buffer.byteLength(json))
    })
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

  // Synchronous reads for a caller's Db.transaction, which re-checks a decision
  // taken outside it. `newest` is by id, the order MessageV2.stream reads in;
  // `prompted` is when a person (or a parent, through the agent tool) last
  // prompted the session, as opposed to a message the loop minted.
  // Excludes compaction requests: the loop writes those as user messages, and
  // they are not a person or a parent asking for work.
  const latest = lazy(async () => {
    const [{ Parts }, q] = await Promise.all([import("./parts"), open()])
    await Parts.removeSessionQuery()
    // Numbered, since the fragment names the session twice.
    return q.db.query<{ at: number | null }, [string]>(`SELECT ${prompts("?1")} AS at`)
  })

  export async function reader() {
    const q = await open()
    const prompted = await latest()
    return {
      newest: (sessionID: string) => {
        const row = q.newest.get(sessionID)
        return row ? (JSON.parse(row.json) as MessageV2.Info) : undefined
      },
      prompted: (sessionID: string) => prompted.get(sessionID)?.at ?? 0,
    }
  }

  export async function remove(messageID: string) {
    const q = await open()
    await Db.retry(() => q.remove.run(messageID))
  }

  export async function removeSession(sessionID: string) {
    const q = await open()
    await Db.retry(() => q.removeSession.run(sessionID))
  }

  export async function removeSessionQuery() {
    return open().then((q) => q.removeSession)
  }

  // A synchronous writer for use inside a caller's Db.transaction, whose body
  // cannot await.
  export async function writer() {
    const q = await open()
    return (message: MessageV2.Info) => {
      const json = JSON.stringify(message)
      q.put.run(message.id, message.sessionID, created(message), json, Buffer.byteLength(json))
    }
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
      const m = (await Bun.file(path.join(dir, entry))
        .json()
        .catch(() => undefined)) as MessageV2.Info | undefined
      if (!m?.id || !m.sessionID || !m.time?.created) continue
      batch.push(m)
      if (batch.length >= Db.MIGRATE_CHUNK) {
        flush(batch)
        batch = []
      }
    }
    if (batch.length) flush(batch)
    return { scanned, inserted }
  }
}
