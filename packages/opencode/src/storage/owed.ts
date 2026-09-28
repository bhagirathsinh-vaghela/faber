import { lazy } from "../util/lazy"
import { Db } from "./db"

// Background jobs whose result their session is still owed. A row is written
// when the job is launched and removed by exactly one of: the delivery (inside
// the same transaction that writes the result message), a kill the session
// asked for, or the session going away. The job record itself stays in JSON
// storage; this row is only the debt, kept in SQLite so the result and the
// payment commit together.
export namespace Owed {
  const open = lazy(async () => {
    const db = await Db.open()
    db.run(`
      CREATE TABLE IF NOT EXISTS job_owed (
        job_id     TEXT NOT NULL PRIMARY KEY,
        session_id TEXT NOT NULL,
        created    INTEGER NOT NULL
      )
    `)
    db.run(`CREATE INDEX IF NOT EXISTS job_owed_session_idx ON job_owed (session_id)`)
    return {
      add: db.query<void, [string, string, number]>(
        `INSERT OR IGNORE INTO job_owed (job_id, session_id, created) VALUES (?, ?, ?)`,
      ),
      remove: db.query<void, [string]>(`DELETE FROM job_owed WHERE job_id = ?`),
      removeSession: db.query<void, [string]>(`DELETE FROM job_owed WHERE session_id = ?`),
      list: db.query<{ job_id: string; session_id: string }, []>(`SELECT job_id, session_id FROM job_owed`),
      session: db.query<{ n: number }, [string]>(`SELECT count(*) AS n FROM job_owed WHERE session_id = ?`),
      has: db.query<{ n: number }, [string]>(`SELECT count(*) AS n FROM job_owed WHERE job_id = ?`),
    }
  })

  export async function add(jobID: string, sessionID: string) {
    const q = await open()
    await Db.retry(() => q.add.run(jobID, sessionID, Date.now()))
  }

  export async function remove(jobID: string) {
    const q = await open()
    await Db.retry(() => q.remove.run(jobID))
  }

  // Everything a session is owed, dropped when the session is stopped or
  // removed: whether or not its job has finished, nobody asked for the result.
  export async function removeSession(sessionID: string) {
    const q = await open()
    await Db.retry(() => q.removeSession.run(sessionID))
  }

  export async function list() {
    return open().then((q) => q.list.all().map((r) => ({ jobID: r.job_id, sessionID: r.session_id })))
  }

  export async function has(jobID: string) {
    return open().then((q) => (q.has.get(jobID)?.n ?? 0) > 0)
  }

  export async function pending(sessionID: string) {
    return open().then((q) => (q.session.get(sessionID)?.n ?? 0) > 0)
  }

  // A synchronous claim for use inside a caller's Db.transaction: true only for
  // the one caller whose delete removed the row.
  export async function claimer() {
    const q = await open()
    return (jobID: string) => q.remove.run(jobID).changes > 0
  }
}
