import { lazy } from "../util/lazy"
import { Db } from "./db"

// What a responder (a background job, or a child session) owes its caller: the
// outcome of the work the caller sent out. A job's row is written at its
// launch; a child's by every message into it, which opens the child's debt or
// joins the one still open. A row is removed only by the one message that
// tells the caller the outcome, inside the transaction that writes it, or by
// the caller or responder being deleted.
export namespace Debt {
  export type Kind = "job" | "subagent"
  // `asks` counts the messages that joined the debt after it opened, so a
  // payer that judged the responder done can tell, inside its paying write,
  // whether a new ask landed since.
  export type Row = { responder: string; kind: Kind; caller: string; created: number; asks: number }

  const COLUMNS = `responder, kind, caller, created, asks`

  const open = lazy(async () => {
    const db = await Db.open()
    db.run(`
      CREATE TABLE IF NOT EXISTS debt (
        responder TEXT NOT NULL PRIMARY KEY,
        kind      TEXT NOT NULL,
        caller    TEXT NOT NULL,
        created   INTEGER NOT NULL,
        asks      INTEGER NOT NULL DEFAULT 0
      )
    `)
    db.run(`CREATE INDEX IF NOT EXISTS debt_caller_idx ON debt (caller)`)
    return {
      add: db.query<void, [string, string, string, number]>(
        `INSERT OR IGNORE INTO debt (responder, kind, caller, created) VALUES (?, ?, ?, ?)`,
      ),
      join: db.query<void, [string]>(`UPDATE debt SET asks = asks + 1 WHERE responder = ?`),
      remove: db.query<void, [string]>(`DELETE FROM debt WHERE responder = ?`),
      drop: db.query<void, [string, string]>(`DELETE FROM debt WHERE caller = ? OR responder = ?`),
      list: db.query<Row, []>(`SELECT ${COLUMNS} FROM debt ORDER BY created`),
      caller: db.query<Row, [string]>(`SELECT ${COLUMNS} FROM debt WHERE caller = ? ORDER BY created`),
      get: db.query<Row, [string]>(`SELECT ${COLUMNS} FROM debt WHERE responder = ?`),
      owing: db.query<{ n: number }, [string]>(`SELECT count(*) AS n FROM debt WHERE caller = ?`),
      callers: db.query<{ caller: string }, []>(`SELECT DISTINCT caller FROM debt`),
    }
  })

  // Resolves once the table exists, for a query elsewhere that joins it.
  export async function ready() {
    await open()
  }

  export async function add(responder: string, kind: Kind, caller: string, created = Date.now()) {
    const q = await open()
    await Db.retry(() => q.add.run(responder, kind, caller, created))
  }

  export async function remove(responder: string) {
    const q = await open()
    await Db.retry(() => q.remove.run(responder))
  }

  // Every debt a deleted session is part of, on either side: nobody is left to
  // pay it or to be told.
  export async function drop(sessionID: string) {
    const q = await open()
    await Db.retry(() => q.drop.run(sessionID, sessionID))
  }

  export async function list() {
    return open().then((q) => q.list.all())
  }

  // Every open debt owed to `caller`.
  export async function owed(caller: string) {
    return open().then((q) => q.caller.all(caller))
  }

  export async function get(responder: string) {
    return open().then((q) => q.get.get(responder) ?? undefined)
  }

  export async function has(responder: string) {
    return get(responder).then((row) => row !== undefined)
  }

  export async function callers() {
    return open().then((q) => q.callers.all().map((row) => row.caller))
  }

  // Whether `caller` is still owed anything.
  export async function owing(caller: string) {
    return open().then((q) => (q.owing.get(caller)?.n ?? 0) > 0)
  }

  // Synchronous checks and writes for use inside a caller's Db.transaction.
  // `pay` is true only for the one caller whose delete removed the row. `owe`
  // records a message into a responder: it opens the debt when none is open,
  // or joins the open one and counts the ask. `join` counts an ask on an open
  // debt only, for a message that must never open one. `get` reads the row.
  export async function claimer() {
    const q = await open()
    const get = (responder: string) => q.get.get(responder) ?? undefined
    const join = (responder: string) => q.join.run(responder).changes > 0
    return {
      get,
      join,
      pay: (responder: string) => q.remove.run(responder).changes > 0,
      owe: (responder: string, kind: Kind, caller: string, created: number) => {
        if (join(responder)) return "joined" as const
        q.add.run(responder, kind, caller, created)
        return "opened" as const
      },
    }
  }
}
