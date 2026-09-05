import path from "path"
import { lazy } from "../util/lazy"
import { Storage } from "./storage"
import { Db } from "./db"
import type { Session } from "../session"

// Sessions, stored as a JSON blob keyed by id, with project_id + time columns
// lifted out (sessions are listed per-project and ordered by recency). A facade
// over the shared Db reproducing the `Storage` semantics the session code uses:
// write (create/import), update (read-modify-write, throws if absent, like
// Storage.update reading the file first), read, per-project list, remove.
export namespace Sessions {
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
      remove: db.query<void, [string]>(`DELETE FROM session WHERE id = ?`),
      db,
    }
  })

  function row(session: Session.Info): [string, string, number, number, string] {
    return [session.id, session.projectID, session.time.created, session.time.updated, JSON.stringify(session)]
  }

  export async function write(session: Session.Info) {
    await open().then((q) => q.put.run(...row(session)))
  }

  // Read-modify-write. Throws NotFoundError when the session is absent, matching
  // Storage.update (which reads the file first).
  export async function update(sessionID: string, fn: (draft: Session.Info) => void) {
    const q = await open()
    const stored = q.get.get(sessionID)
    if (!stored) throw new Storage.NotFoundError({ message: `Session not found: ${sessionID}` })
    const draft = JSON.parse(stored.json) as Session.Info
    fn(draft)
    q.put.run(...row(draft))
    return draft
  }

  export async function read(sessionID: string) {
    const stored = await open().then((q) => q.get.get(sessionID))
    if (!stored) throw new Storage.NotFoundError({ message: `Session not found: ${sessionID}` })
    return JSON.parse(stored.json) as Session.Info
  }

  export async function listProject(projectID: string) {
    const rows = await open().then((q) => q.listProject.all(projectID))
    return rows.map((r) => JSON.parse(r.json) as Session.Info)
  }

  export async function remove(sessionID: string) {
    await open().then((q) => q.remove.run(sessionID))
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
      const s = (await Bun.file(path.join(dir, entry)).json().catch(() => undefined)) as Session.Info | undefined
      if (!s?.id || !s.projectID || !s.time?.created || !s.time?.updated) continue
      batch.push(s)
      if (batch.length >= 5000) {
        flush(batch)
        batch = []
      }
    }
    if (batch.length) flush(batch)
    return { scanned, inserted }
  }
}
