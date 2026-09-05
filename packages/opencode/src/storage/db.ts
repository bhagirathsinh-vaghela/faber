import { Database } from "bun:sqlite"
import path from "path"
import { Global } from "../global"
import { lazy } from "../util/lazy"
import { Storage } from "./storage"

// The one SQLite connection for session records. Sessions, messages, and parts
// share it: one file, one WAL, one set of PRAGMAs. Parts are the reason it
// exists — they are rewritten from every streaming delta, so N active sessions
// turn whole-file rewrites + renames + inode churn into a disk storm. Messages
// and sessions moved in too, so the whole session tree is one indexed file
// instead of hundreds of thousands of tiny JSON files. Each record is stored as
// a JSON blob with only its key/index fields lifted into real columns (the
// hybrid pattern) — a blob is not indexable, so anything filtered or ordered on
// lives as a column.
//
// WAL is a local-filesystem journal mode: pointing Global.Path.data at NFS would
// corrupt it. Keep storage on local disk.
export namespace Db {
  // Rows per migration transaction: one fsync's worth, small enough that a
  // 272k-file import never holds gigabytes of pending rows in memory. Shared so
  // all three facades' migrators chunk identically.
  export const MIGRATE_CHUNK = 5000

  export const open = lazy(async () => {
    // Wait for the storage dir to exist (migrations that fill these tables from
    // the legacy JSON tree run as a standalone command, not here).
    await Storage.ready()
    const db = new Database(path.join(Global.Path.data, "storage", "storage.db"))
    db.run("PRAGMA journal_mode = WAL")
    db.run("PRAGMA synchronous = NORMAL")
    db.run("PRAGMA busy_timeout = 5000")
    db.run("PRAGMA temp_store = MEMORY")
    db.run("PRAGMA cache_size = -8000")
    return db
  })

  // Run writes as one atomic unit on the shared connection, so a crash between
  // them cannot leave a record half-deleted (an orphan part whose message is
  // gone, a session row with no transcript). The callback runs synchronously
  // inside bun:sqlite's transaction; a caller awaits its statements ready first.
  export async function transaction(fn: () => void) {
    const db = await open()
    db.transaction(fn)()
  }

  // Reap rows whose owner is gone: parts whose message is deleted, messages whose
  // session is deleted. No schema FK enforces this (the tables predate one, and
  // adding it means a live table rebuild), so the sweep is the GC. Warms the
  // three facades first so every table exists.
  export async function sweepOrphans() {
    const [{ Parts }, { Messages }, { Sessions }] = await Promise.all([
      import("./parts"),
      import("./messages"),
      import("./sessions"),
    ])
    await Promise.all([
      Parts.list("__warm__"),
      Messages.read("__warm__").catch(() => undefined),
      Sessions.listProject("__warm__"),
    ])
    const db = await open()
    const parts = db.run(`DELETE FROM part WHERE message_id NOT IN (SELECT id FROM message)`).changes
    const messages = db.run(`DELETE FROM message WHERE session_id NOT IN (SELECT id FROM session)`).changes
    return { parts, messages }
  }

  // The boot trigger, memoized so a restart's re-import of this module does not
  // re-sweep. Tests call sweepOrphans directly.
  export const sweepOrphansOnce = lazy(sweepOrphans)
}
