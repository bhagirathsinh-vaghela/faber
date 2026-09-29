import { lazy } from "../util/lazy"
import { Lock } from "../util/lock"
import { Db } from "./db"
import type { BackgroundJob } from "../background/job"

// Background job records, one JSON blob per job with the columns the reads
// filter by lifted out. The record lives beside the debt table so a claim on a
// job and the debt it settles can commit in one transaction. The job's output
// and exit code stay files: a detached process appends to them after the
// server is gone, which a row cannot be.
export namespace Jobs {
  const open = lazy(async () => {
    const db = await Db.open()
    db.run(`
      CREATE TABLE IF NOT EXISTS job (
        id           TEXT NOT NULL PRIMARY KEY,
        session_id   TEXT NOT NULL,
        status       TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        json         TEXT NOT NULL
      )
    `)
    db.run(`CREATE INDEX IF NOT EXISTS job_session_idx ON job (session_id, status)`)
    return {
      put: db.query<void, [string, string, string, number, string]>(
        `INSERT INTO job (id, session_id, status, time_created, json) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, status = excluded.status,
           time_created = excluded.time_created, json = excluded.json`,
      ),
      get: db.query<{ json: string }, [string]>(`SELECT json FROM job WHERE id = ?`),
      list: db.query<{ json: string }, []>(`SELECT json FROM job ORDER BY time_created, id`),
      remove: db.query<void, [string]>(`DELETE FROM job WHERE id = ?`),
    }
  })

  function row(job: BackgroundJob.Info): [string, string, string, number, string] {
    return [job.id, job.sessionID, job.status, job.time.created, JSON.stringify(job)]
  }

  export async function put(job: BackgroundJob.Info) {
    const q = await open()
    await Db.retry(() => q.put.run(...row(job)))
  }

  export async function get(id: string) {
    const q = await open()
    const stored = q.get.get(id)
    return stored ? (JSON.parse(stored.json) as BackgroundJob.Info) : undefined
  }

  export async function list() {
    const q = await open()
    return q.list.all().map((stored) => JSON.parse(stored.json) as BackgroundJob.Info)
  }

  export async function remove(id: string) {
    const q = await open()
    await Db.retry(() => q.remove.run(id))
  }

  // Read-modify-write in one transaction, so two passes (or two processes)
  // claiming the same transition cannot both win. `fn` returns false to leave
  // the record as it is. Undefined when the record is absent or unchanged.
  export async function update(id: string, fn: (draft: BackgroundJob.Info) => boolean | void) {
    const q = await open()
    using _ = await Lock.write("job/" + id)
    return Db.transaction(() => {
      const stored = q.get.get(id)
      if (!stored) return undefined
      const draft = JSON.parse(stored.json) as BackgroundJob.Info
      if (fn(draft) === false) return undefined
      q.put.run(...row(draft))
      return draft
    })
  }

  // A synchronous write for use inside a caller's Db.transaction, so a job's
  // record commits together with the debt its launch opens.
  export async function writer() {
    const q = await open()
    return (job: BackgroundJob.Info) => void q.put.run(...row(job))
  }

  // A synchronous read-modify-write for use inside a caller's Db.transaction,
  // so a job claim commits together with the debt it pays.
  export async function mutator() {
    const q = await open()
    return (id: string, fn: (draft: BackgroundJob.Info) => boolean) => {
      const stored = q.get.get(id)
      if (!stored) return undefined
      const draft = JSON.parse(stored.json) as BackgroundJob.Info
      if (!fn(draft)) return undefined
      q.put.run(...row(draft))
      return draft
    }
  }

  // A synchronous read of one record's status, for a claim that must hold
  // only while the job is in that state.
  export async function reader() {
    const q = await open()
    return (id: string) => {
      const stored = q.get.get(id)
      return stored ? (JSON.parse(stored.json) as BackgroundJob.Info).status : undefined
    }
  }
}
