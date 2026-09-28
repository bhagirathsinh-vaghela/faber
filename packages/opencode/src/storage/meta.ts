import { lazy } from "../util/lazy"
import { Db } from "./db"

// Small per-database facts that belong to the store rather than to any record:
// which process runs recovery (the lease) and which one-time migrations ran.
// Each data directory has its own database, so each fact is per store.
export namespace Meta {
  const open = lazy(async () => {
    const db = await Db.open()
    db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL)`)
    return {
      get: db.query<{ value: string }, [string]>(`SELECT value FROM meta WHERE key = ?`),
      put: db.query<void, [string, string]>(
        `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ),
    }
  })

  // Read-modify-write in one IMMEDIATE transaction, so two processes deciding
  // on the same key cannot both win. `fn` returns the new value, or undefined
  // to leave the row as it is. Returns whether it wrote.
  export async function update(key: string, fn: (value: string | undefined) => string | undefined) {
    const q = await open()
    return Db.transaction(() => {
      const next = fn(q.get.get(key)?.value)
      if (next === undefined) return false
      q.put.run(key, next)
      return true
    })
  }

  export async function get(key: string) {
    return open().then((q) => q.get.get(key)?.value)
  }
}
