import path from "path"
import { lazy } from "../util/lazy"
import { Lock } from "../util/lock"
import { Storage } from "./storage"
import { Db } from "./db"
import type { Session } from "../session"
import { Log } from "../util/log"

// Sessions, stored as a JSON blob keyed by id, with project_id + time columns
// lifted out (sessions are listed per-project and ordered by recency), and the
// fields the cross-project scans filter on generated from the blob (`Db.lift`). A facade
// over the shared Db reproducing the `Storage` semantics the session code uses:
// write (create/import), update (read-modify-write, throws if absent, like
// Storage.update reading the file first), read, per-project list, remove.
export namespace Sessions {
  const log = Log.create({ service: "sessions" })

  const open = lazy(async () => {
    const db = await Db.open()
    db.run(`
      CREATE TABLE IF NOT EXISTS session (
        id           TEXT NOT NULL PRIMARY KEY,
        project_id   TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        json         TEXT NOT NULL
      )
    `)
    db.run(`CREATE INDEX IF NOT EXISTS session_project_idx ON session (project_id)`)
    // Every cross-project scan below filters on these, so each is an index
    // read instead of a JSON parse of every session.
    await Db.lift(
      db,
      "session",
      {
        parent: ["TEXT", "$.parentID"],
        turn: ["TEXT", "$.turn"],
        archived: ["INTEGER", "$.time.archived"],
        stopped: ["INTEGER", "$.time.stopped"],
        keep: ["INTEGER", "$.keepWarm"],
        starred: ["INTEGER", "$.starred"],
        ephemeral: ["INTEGER", "$.ephemeral"],
        request: ["INTEGER", "$.cache.lastRequestAt"],
      },
      {
        session_parent_idx: `ON session (parent)`,
        session_idle_idx: `ON session (archived, turn, stopped, id)`,
        session_turning_idx: `ON session (id) WHERE turn IS NOT NULL`,
        session_ephemeral_idx: `ON session (time_created) WHERE ephemeral = 1`,
        session_warm_idx: `ON session (request) WHERE keep = 1 AND parent IS NULL AND ephemeral IS NOT 1`,
        session_archived_idx: `ON session (archived) WHERE archived > 0 AND parent IS NULL`,
        session_starred_idx: `ON session (id) WHERE starred = 1 AND parent IS NULL`,
      },
    )
    return {
      get: db.query<{ json: string }, [string]>(`SELECT json FROM session WHERE id = ?`),
      put: db.query<void, [string, string, number, number, string]>(
        `INSERT INTO session (id, project_id, time_created, time_updated, json) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, time_created = excluded.time_created,
           time_updated = excluded.time_updated, json = excluded.json`,
      ),
      importRow: db.query<void, [string, string, number, number, string]>(
        `INSERT OR IGNORE INTO session (id, project_id, time_created, time_updated, json) VALUES (?, ?, ?, ?, ?)`,
      ),
      listProject: db.query<{ json: string }, [string]>(`SELECT json FROM session WHERE project_id = ?`),
      archived: db.query<{ archived: number | null }, [string]>(`SELECT archived FROM session WHERE id = ?`),
      listArchived: db.query<{ json: string }, []>(
        `SELECT json FROM session WHERE archived > 0 AND parent IS NULL ORDER BY archived DESC`,
      ),
      listStarred: db.query<{ id: string; json: string }, []>(
        `SELECT id, json FROM session WHERE starred = 1 AND parent IS NULL`,
      ),
      listTurning: db.query<{ id: string; json: string }, []>(`SELECT id, json FROM session WHERE turn IS NOT NULL`),
      listWarm: db.query<{ id: string; json: string }, [number]>(
        `SELECT id, json FROM session WHERE parent IS NULL AND keep = 1 AND ephemeral IS NOT 1 AND request > ?`,
      ),
      listEphemeral: db.query<{ id: string; json: string }, [number]>(
        `SELECT id, json FROM session WHERE ephemeral = 1 AND time_created < ?`,
      ),
      children: db.query<{ id: string }, [string]>(`SELECT id FROM session WHERE parent = ?`),
      remove: db.query<void, [string]>(`DELETE FROM session WHERE id = ?`),
      db,
    }
  })

  function row(session: Session.Info): [string, string, number, number, string] {
    return [session.id, session.projectID, session.time.created, session.time.updated, JSON.stringify(session)]
  }

  export async function write(session: Session.Info) {
    const q = await open()
    await Db.retry(() => q.put.run(...row(session)))
  }

  // The schema, resolved through a lazy import that breaks the storage ->
  // session cycle, then held so a caller inside a synchronous transaction body
  // can parse without awaiting.
  let schema: typeof Session.Info | undefined
  async function ready() {
    schema ??= await import("../session").then((x) => x.Session.Info)
    return schema
  }

  // Run the stored blob through the schema so its `.default(...)` clauses fill
  // fields a pre-feature record never had (tokens, total, cost). A bare cast
  // would leave them undefined, and a mutator like `draft.total.input += x` then
  // throws on an old session.
  function parse(json: string) {
    return schema!.parse(JSON.parse(json))
  }

  async function normalize(json: string): Promise<Session.Info> {
    await ready()
    return parse(json)
  }

  // A cross-project scan's rows, skipping any that no longer fit the schema:
  // one unreadable session must not fail the scan for every other one. A torn
  // row's generated columns read as NULL (`Db.lift` guards them with
  // json_valid), and WAITING checks json_valid on what it returns, so a torn
  // row is never selected and every row here parses.
  async function scan(rows: { id: string; json: string }[]) {
    await ready()
    return rows.flatMap((r) => {
      const parsed = schema!.safeParse(JSON.parse(r.json))
      if (parsed.success) return [parsed.data]
      log.error("skipping an unreadable session", { sessionID: r.id, error: parsed.error.message })
      return []
    })
  }

  // Read-modify-write, throwing NotFoundError when the session is absent, like
  // Storage.update (which reads the file first).
  //
  // Two locks, because they cover different racers and neither substitutes for
  // the other. Lock.write serializes the coroutines of THIS process. The
  // IMMEDIATE transaction serializes against OTHER processes — a second server
  // (the staging one a /restart runs) shares the file but not the Map behind
  // Lock, so without it both processes read the same blob and the later write
  // silently discards the earlier mutation, with no error on either side.
  //
  // The read, the mutation, and the write all sit INSIDE the transaction; that
  // adjacency is the whole point, since a read outside it could be stale by the
  // time the write lands. The schema is resolved beforehand because
  // bun:sqlite's transaction callback is synchronous and cannot await.
  export async function update(sessionID: string, fn: (draft: Session.Info) => void) {
    const q = await open()
    using _ = await Lock.write("session/" + sessionID)
    // Resolve the schema before the synchronous transaction body needs it.
    await ready()
    let draft!: Session.Info
    await Db.transaction(() => {
      const current = q.get.get(sessionID)
      if (!current) throw new Storage.NotFoundError({ message: `Session not found: ${sessionID}` })
      draft = parse(current.json)
      fn(draft)
      q.put.run(...row(draft))
    })
    return draft
  }

  export async function read(sessionID: string) {
    const stored = await open().then((q) => q.get.get(sessionID))
    if (!stored) throw new Storage.NotFoundError({ message: `Session not found: ${sessionID}` })
    return normalize(stored.json)
  }

  export async function listProject(projectID: string) {
    const rows = await open().then((q) => q.listProject.all(projectID))
    return Promise.all(rows.map((r) => normalize(r.json)))
  }

  // Returns a synchronous reader of the stored archive flag, for a caller that
  // must check it in the same tick as an action the check gates.
  export async function archivedReader() {
    const q = await open()
    return (sessionID: string) => {
      const stored = q.archived.get(sessionID)
      return (stored?.archived ?? 0) > 0
    }
  }

  export async function listArchived() {
    const rows = await open().then((q) => q.listArchived.all())
    return Promise.all(rows.map((r) => normalize(r.json)))
  }

  // The recovery sweep's query, exported so a test explains this exact text.
  // MATERIALIZED evaluates each idle session's newest reply once, before the
  // probe for a user message after it. The torn-row check sits on the outer
  // select, so it reads only the sessions the sweep returns.
  export const WAITING = `WITH idle AS MATERIALIZED (
       SELECT s.id, s.stopped, coalesce((SELECT r.parent FROM message r
         WHERE r.session_id = s.id AND r.role = 'assistant' ORDER BY r.id DESC LIMIT 1), '') AS answered
       FROM session s WHERE s.turn IS NULL AND (s.archived IS NULL OR s.archived = 0)
     )
     SELECT s.id, s.json FROM idle i JOIN session s ON s.id = i.id
     WHERE json_valid(s.json) AND EXISTS (SELECT 1 FROM message m
       WHERE m.session_id = i.id AND m.role = 'user' AND m.id > i.answered
         -- Unary plus keeps the time range off the index, so the probe
         -- seeks (session_id, role, id) instead of parsing each message.
         AND +m.time_created > coalesce(i.stopped, 0) AND +m.time_created < ?
         AND (m.synthetic = 1 OR EXISTS (SELECT 1 FROM debt d WHERE d.responder = i.id)))`

  // Prepared on first use, after the message and debt tables they join are
  // known to exist.
  const joined = lazy(async () => {
    const [{ Messages }, { Debt }, q] = await Promise.all([import("./messages"), import("./debt"), open()])
    await Promise.all([Messages.reader(), Debt.ready()])
    return {
      waiting: q.db.query<{ id: string; json: string }, [number]>(WAITING),
      debted: q.db.query<{ id: string }, [string]>(
        `SELECT s.id FROM session s WHERE s.parent = ?
           AND (EXISTS (SELECT 1 FROM debt d WHERE d.responder = s.id) OR EXISTS (SELECT 1 FROM debt d WHERE d.caller = s.id))`,
      ),
    }
  })

  // Sessions with a user message no reply has answered, written after the
  // last stop, with no turn marked: a delivered result whose wake was lost, or
  // a subagent's prompt whose process died before its turn began. "Unanswered"
  // is the rule Messages.reader().waiting uses (one written after the newest
  // reply's own request, which a reply that never saw it may sort after); the
  // message must also be synthetic, or the session itself a responder with an
  // open debt, so a person's own message sent with noReply is left alone. Only messages
  // written before `before` count, so a sweep leaves alone one whose turn
  // another process is about to mark.
  export async function listUnanswered(before = Number.MAX_SAFE_INTEGER) {
    return scan(await joined().then((q) => q.waiting.all(before)))
  }

  // The ids of a session's direct children, across every project.
  export async function children(parentID: string) {
    return open().then((q) => q.children.all(parentID).map((row) => row.id))
  }

  // The ids of a session's children that have a debt in either direction:
  // owed by the session, or owed something themselves.
  export async function debted(parentID: string) {
    return joined().then((q) => q.debted.all(parentID).map((row) => row.id))
  }

  export async function listStarred() {
    return scan(await open().then((q) => q.listStarred.all()))
  }

  // Sessions carrying a turn marker, across every project.
  export async function listTurning() {
    return scan(await open().then((q) => q.listTurning.all()))
  }

  // Attended (root, not ephemeral) sessions that asked to stay warm and whose
  // cache anchor is after `since`.
  export async function listWarm(since: number) {
    return scan(await open().then((q) => q.listWarm.all(since)))
  }

  // A synchronous read for use inside a caller's Db.transaction.
  export async function reader() {
    const q = await open()
    await ready()
    return (sessionID: string) => {
      const current = q.get.get(sessionID)
      return current ? parse(current.json) : undefined
    }
  }

  // A synchronous read-modify-write for use inside a caller's Db.transaction.
  // `fn` returns false to abort the write (the claim was lost).
  export async function mutator() {
    const q = await open()
    await ready()
    return (sessionID: string, fn: (draft: Session.Info) => boolean) => {
      const current = q.get.get(sessionID)
      if (!current) return undefined
      const draft = parse(current.json)
      if (!fn(draft)) return undefined
      q.put.run(...row(draft))
      return draft
    }
  }

  // Headless-run sessions created before `before`, across every project.
  export async function listEphemeral(before: number) {
    return scan(await open().then((q) => q.listEphemeral.all(before)))
  }

  export async function remove(sessionID: string) {
    const q = await open()
    await Db.retry(() => q.remove.run(sessionID))
  }

  export async function removeQuery() {
    return open().then((q) => q.remove)
  }

  // Import the legacy `session/<projectID>/<sessionID>.json` tree into the table.
  // Same contract as Parts.migrate: server DOWN, INSERT OR IGNORE (idempotent),
  // non-destructive. Returns { scanned, inserted }.
  export async function migrate() {
    const dir = await Storage.ready().then((x) => x.dir)
    const q = await open()
    let scanned = 0
    let inserted = 0
    const flush = q.db.transaction((rows: Session.Info[]) => {
      for (const s of rows) {
        if (q.importRow.run(...row(s)).changes > 0) inserted++
      }
    })
    let batch = [] as Session.Info[]
    // A session's project dir is the worktree PATH (e.g. session/Users/.../repo/),
    // so the file sits many levels deep, not at session/<projectID>/. Scan
    // recursively; the id/projectID come from the file body, not the path. `dot`
    // is required: a worktree under a hidden dir (e.g. ~/.config)
    // otherwise never matches, since Bun.Glob skips dot-dirs by default.
    for await (const entry of new Bun.Glob("session/**/*.json").scan({ cwd: dir, onlyFiles: true, dot: true })) {
      scanned++
      const s = (await Bun.file(path.join(dir, entry))
        .json()
        .catch(() => undefined)) as Session.Info | undefined
      if (!s?.id || !s.projectID || !s.time?.created || !s.time?.updated) continue
      batch.push(s)
      if (batch.length >= Db.MIGRATE_CHUNK) {
        flush(batch)
        batch = []
      }
    }
    if (batch.length) flush(batch)
    return { scanned, inserted }
  }
}
