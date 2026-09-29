import path from "path"
import { lazy } from "../util/lazy"
import { Storage } from "./storage"
import { Db } from "./db"
import type { MessageV2 } from "../session/message-v2"

// Messages, stored as a JSON blob keyed by id, with session_id + time_created
// lifted into columns (the fields the reads order and scan by), and role,
// parent and synthetic generated from the blob for recovery (`Db.lift`). A facade over
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
    // What recovery reads filter on. Newest reply and the probe for a user
    // message after it: (session_id, role, id). Newest message and the scan
    // after a reply: (session_id, id).
    await Db.lift(
      db,
      "message",
      { role: ["TEXT", "$.role"], parent: ["TEXT", "$.parentID"], synthetic: ["INTEGER", "$.synthetic"] },
      {
        message_session_role_idx: `ON message (session_id, role, id)`,
        message_session_id_idx: `ON message (session_id, id)`,
      },
    )
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
      // The newest assistant message, the reply the session last made.
      reply: db.query<{ json: string }, [string]>(
        `SELECT json FROM message WHERE session_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1`,
      ),
      after: db.query<{ json: string }, [string, string]>(
        `SELECT json FROM message WHERE session_id = ? AND id >= ? ORDER BY id`,
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
  // taken outside it. `newest` is by id, the order MessageV2.stream reads in.
  // `waiting` is a user message written after the newest reply's own request
  // that no reply links to: a message written while a step was starting sorts
  // before the reply that never saw it (MessageV2.filterCompacted moves it
  // after), so the newest row alone would read it as answered.
  // `pending` is the first such message written after `since` (a stop's
  // stamp, say), for a caller that needs its id or time rather than the
  // newest row's.
  // `aborted` is a last turn an interrupt ended, which waits for a new message.
  export async function reader() {
    const q = await open()
    const parse = (row: { json: string } | null) => (row ? (JSON.parse(row.json) as MessageV2.Info) : undefined)
    const pending = (sessionID: string, since = 0) => {
      const reply = parse(q.reply.get(sessionID))
      if (reply?.role !== "assistant") {
        const newest = parse(q.newest.get(sessionID))
        return newest?.role === "user" && newest.time.created > since ? newest : undefined
      }
      return q.after
        .all(sessionID, reply.parentID)
        .map(parse)
        .find((msg) => msg?.role === "user" && msg.id !== reply.parentID && msg.time.created > since)
    }
    return {
      newest: (sessionID: string) => parse(q.newest.get(sessionID)),
      pending,
      waiting: (sessionID: string, since = 0) => !!pending(sessionID, since),
      // A last turn a stop or an Esc cut: its reply was aborted, or a message
      // still unanswered when `since` (the stop) landed was dropped by it.
      // Either way the session waits for a new message; reading it as done
      // would report the previous task's reply as this one's result.
      interrupted: (sessionID: string, since = 0) => {
        const reply = parse(q.reply.get(sessionID))
        if (reply?.role === "assistant" && reply.error?.name === "MessageAbortedError") return true
        return !!pending(sessionID) && !pending(sessionID, since)
      },
      aborted: (sessionID: string) => {
        const reply = parse(q.reply.get(sessionID))
        return reply?.role === "assistant" && reply.error?.name === "MessageAbortedError"
      },
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
