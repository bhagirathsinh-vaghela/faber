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
    db.run("PRAGMA foreign_keys = ON")
    return db
  })
}
