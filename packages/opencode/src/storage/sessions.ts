import path from "path"
import { lazy } from "../util/lazy"
import { Lock } from "../util/lock"
import { Storage } from "./storage"
import { Db } from "./db"
import type { Session } from "../session"
import { Log } from "../util/log"

// Sessions, stored as a JSON blob keyed by id, with project_id + time columns
// lifted out (sessions are listed per-project and ordered by recency). A facade
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
      archived: db.query<{ archived: number | null }, [string]>(
        `SELECT json_extract(json, '$.time.archived') AS archived FROM session WHERE id = ?`,
      ),
      listArchived: db.query<{ json: string }, []>(
        `SELECT json FROM session
         WHERE json_extract(json, '$.time.archived') > 0 AND json_extract(json, '$.parentID') IS NULL
         ORDER BY json_extract(json, '$.time.archived') DESC`,
      ),
      listTurning: db.query<{ id: string; json: string }, []>(
        `SELECT id, json FROM session WHERE CASE WHEN json_valid(json) THEN json_extract(json, '$.turn') IS NOT NULL END`,
      ),
      listWarm: db.query<{ id: string; json: string }, [number]>(
        `SELECT id, json FROM session
         WHERE CASE WHEN json_valid(json) THEN json_extract(json, '$.parentID') IS NULL AND json_extract(json, '$.keepWarm') = 1
           AND coalesce(json_extract(json, '$.ephemeral'), 0) = 0
           AND json_extract(json, '$.cache.lastRequestAt') > ? END`,
      ),
      listEphemeral: db.query<{ id: string; json: string }, [number]>(
        `SELECT id, json FROM session WHERE CASE WHEN json_valid(json) THEN json_extract(json, '$.ephemeral') = 1 AND time_created < ? END`,
      ),
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
  // one unreadable session must not fail the scan for every other one. Its
  // queries read a row's JSON only inside `CASE WHEN json_valid(...)`, which
  // SQLite evaluates in order (json_extract throws on a malformed blob), so a
  // torn row is never selected and every row here parses.
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

  // Subagents whose parent is owed a result, across every project: the rule in
  // Recovery.owed, evaluated in SQL so a pass reads only the few that qualify.
  // Prepared on first use, after the message table it joins is known to exist.
  const owing = lazy(async () => {
    const [{ Messages }, q] = await Promise.all([import("./messages"), open()])
    await Messages.reader()
    return {
      owed: q.db.query<{ id: string; json: string }, []>(
        `SELECT s.id, s.json FROM session s
         WHERE CASE WHEN json_valid(s.json) THEN json_extract(s.json, '$.parentID') IS NOT NULL
           AND json_extract(s.json, '$.time.injected') IS NOT NULL
           AND ${Messages.prompts("s.id")}
               > max(json_extract(s.json, '$.time.injected'), coalesce(json_extract(s.json, '$.time.stopped'), 0)) END`,
      ),
      unprompted: q.db.query<{ id: string; json: string }, []>(
        `SELECT s.id, s.json FROM session s
         WHERE CASE WHEN json_valid(s.json) THEN json_extract(s.json, '$.parentID') IS NOT NULL
           AND json_extract(s.json, '$.time.injected') = 0
           AND json_extract(s.json, '$.time.stopped') IS NULL
           AND NOT EXISTS (SELECT 1 FROM message WHERE session_id = s.id AND time_created >= s.time_created) END`,
      ),
      unanswered: q.db.query<{ id: string; json: string }, [number]>(
        `SELECT s.id, s.json FROM session s
         WHERE CASE WHEN json_valid(s.json) THEN json_extract(s.json, '$.turn') IS NULL
           AND EXISTS (SELECT 1 FROM message m
             WHERE m.id = (SELECT id FROM message WHERE session_id = s.id ORDER BY id DESC LIMIT 1)
               AND CASE WHEN json_valid(m.json) THEN json_extract(m.json, '$.role') = 'user'
                 AND m.time_created < ?
                 AND m.time_created > coalesce(json_extract(s.json, '$.time.stopped'), 0)
                 AND (json_extract(m.json, '$.synthetic') = 1
                   OR (json_extract(s.json, '$.parentID') IS NOT NULL AND json_extract(s.json, '$.time.injected') IS NOT NULL)) END) END`,
      ),
    }
  })

  // Sessions whose newest message (by id, the order the loop reads in) is a
  // request no turn has taken up, written before `before` and after the last
  // stop, with no turn marked: a delivered result whose wake was lost, or a
  // subagent's prompt whose process died before its turn began. A person's own
  // message sent with noReply is left alone: it is neither synthetic nor a
  // subagent's.
  export async function listUnanswered(before: number) {
    return scan(await owing().then((q) => q.unanswered.all(before)))
  }

  export async function listOwed() {
    return scan(await owing().then((q) => q.owed.all()))
  }

  // Subagents launched but never prompted and never reported: a launch whose
  // prompt was not written before its process went away. Judged by the child
  // having no message written since it was created (its first is its prompt;
  // context copied from the parent keeps the parent's older times), which
  // reads no JSON, so a torn prompt row cannot make a running child look
  // never-prompted.
  export async function listUnprompted() {
    return scan(await owing().then((q) => q.unprompted.all()))
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

  // Whether a stop landed on the session's running turn: a stop at or after
  // the turn's start, or after `since` when no turn is marked. What a launch
  // from inside a turn (a job, a subagent) checks, since a stop stamps first
  // and cancels the turn last.
  export async function halted(sessionID: string, since: number) {
    const session = await read(sessionID).catch(() => undefined)
    return (session?.time.stopped ?? 0) >= (session?.turn?.at ?? since)
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
