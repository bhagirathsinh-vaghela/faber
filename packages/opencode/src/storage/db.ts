import { Database } from "bun:sqlite"
import path from "path"
import { Global } from "../global"
import { Log } from "../util/log"
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

  // How long SQLite itself waits for the write lock before handing back BUSY.
  // Sized above the slowest legitimate write rather than against a "typical"
  // one: a sub-millisecond part upsert never approaches it, and the ceiling only
  // matters when something unusually large is committing in another process.
  export const BUSY_TIMEOUT = 15_000

  // Retries AFTER busy_timeout has already elapsed, so this is the second line
  // of defence, not the first. Jittered because a fixed backoff makes every
  // blocked writer wake together and re-collide (the convoy pattern).
  const RETRY_MAX = 5
  const RETRY_BASE = 25

  // The busy family, which SQLite documents as "try again": the lock was held,
  // nothing is wrong with the statement. SQLITE_BUSY_SNAPSHOT is the exception
  // that cannot be fixed by re-running the statement alone — its transaction
  // holds a stale snapshot, so the whole transaction has to restart. It is
  // listed because `transaction` retries at that granularity; a bare statement
  // retry never encounters it.
  const BUSY = new Set(["SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT", "SQLITE_BUSY_RECOVERY", "SQLITE_BUSY_TIMEOUT"])

  export function busy(e: unknown): e is { code: string } {
    return BUSY.has((e as { code?: string })?.code ?? "")
  }

  // Run a storage write so a lock held elsewhere costs latency instead of an
  // error. Without this a turn dies for a contention SQLite expects the caller
  // to wait out.
  export async function retry<T>(fn: () => T): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return fn()
      } catch (e) {
        if (!busy(e) || attempt >= RETRY_MAX) throw e
        await Bun.sleep(RETRY_BASE * 2 ** attempt * (0.5 + Math.random()))
      }
    }
  }

  // The open connection, for `close` to reach without awaiting `open` (a signal
  // handler cannot await, and must never force a connection open just to shut
  // one down). Undefined until something actually opens the database.
  let connection: Database | undefined

  export const open = lazy(async () => {
    // Wait for the storage dir to exist (migrations that fill these tables from
    // the legacy JSON tree run as a standalone command, not here).
    await Storage.ready()
    const db = new Database(path.join(Global.Path.data, "storage", "storage.db"))
    // busy_timeout FIRST: it governs every statement after it, including the
    // journal_mode switch below, which takes an exclusive lock and is therefore
    // the open's most contended statement. Without the timeout already in place,
    // that switch runs with a zero wait and throws SQLITE_BUSY whenever another
    // process is opening the file or recovering its WAL.
    db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT}`)
    // journal_mode is persisted in the file, so re-issuing it spends an
    // exclusive lock to set what is already set. Read first, write on mismatch.
    if (db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode !== "wal")
      db.run("PRAGMA journal_mode = WAL")
    db.run("PRAGMA synchronous = NORMAL")
    db.run("PRAGMA temp_store = MEMORY")
    // 64MB of page cache. The store is well past a gigabyte, so a smaller cache
    // holds a fraction of a percent of it and every read walks to disk.
    db.run("PRAGMA cache_size = -64000")
    // NOTHING that writes belongs here. `open` is the boot path, it runs before
    // anything can retry it, and a write here holds SQLite's one write lock
    // against every other process — which is how a second server booting beside
    // a live one kills the live one's turn. PRAGMA optimize looks harmless and
    // is not: on a store with no stats yet it measured 26s of scanning and 8KB
    // of WAL. Statistics are gathered in `close` instead, where the process is
    // ending and holding the lock costs nobody.
    connection = db
    return db
  })

  // Fold the WAL back into the database and release the connection, for a stop
  // the process knows is coming (a signal, which is how the supervisor ends a
  // server on /restart and /stop).
  //
  // A process that just dies leaves its WAL for whoever opens next to recover,
  // and that recovery takes an exclusive lock — the source of the
  // SQLITE_BUSY_RECOVERY a concurrent open can hit. Checkpointing here means
  // the next process opens a database that needs no recovery.
  //
  // TRUNCATE rather than PASSIVE: PASSIVE gives up when a reader holds a frame
  // it would remove, and this is the one moment worth insisting, since nothing
  // is going to run afterwards. Synchronous throughout, because a signal
  // handler cannot await, and it never opens a connection that was not already
  // open — a CLI that touched no storage has nothing to checkpoint.
  export function close() {
    if (!connection) return
    const db = connection
    connection = undefined
    try {
      // Drop the timeout first. TRUNCATE waits on the busy handler, so the 15s
      // an ordinary write is allowed would become 15s of a supervisor's
      // restart, and the supervisor kills without a timeout of its own.
      db.run("PRAGMA busy_timeout = 250")
      db.run("PRAGMA wal_checkpoint(TRUNCATE)")
    } catch (e) {
      // The WAL stays for the next open to recover, which is slower but
      // correct. Logged rather than swallowed: folding the WAL back in is the
      // one thing this function exists to do, so a silent failure would hide
      // the feature not working at all.
      Log.Default.warn("storage checkpoint failed", { e })
    }
    db.close()
  }

  // Run writes as one atomic unit on the shared connection, so a crash between
  // them cannot leave a record half-deleted (an orphan part whose message is
  // gone, a session row with no transcript). The callback runs synchronously
  // inside bun:sqlite's transaction; a caller awaits its statements ready first.
  //
  // IMMEDIATE, not bun's default DEFERRED. A DEFERRED transaction that reads
  // before it writes takes a read snapshot and only asks for the write lock at
  // its first write; if another process committed in that window the upgrade
  // fails with SQLITE_BUSY_SNAPSHOT, which the busy handler deliberately does
  // NOT wait on — the snapshot is stale, so no amount of waiting makes the
  // statement valid. Declaring the writer intent at BEGIN turns that into
  // ordinary lock contention, which busy_timeout and `retry` both handle.
  //
  // Retrying wraps the WHOLE transaction because that is the only granularity
  // at which a stale snapshot can be discarded and re-read.
  export async function transaction(fn: () => void) {
    const db = await open()
    await retry(() => db.transaction(fn).immediate())
  }

  // Reap rows whose owner is gone: parts whose message is deleted, messages whose
  // session is deleted. No schema FK enforces this (the tables predate one, and
  // adding it means a live table rebuild), so the sweep is the GC. Warms the
  // three facades first so every table exists.
  //
  // Each delete is skipped when its OWNER table is empty. An empty owner never
  // happens on a populated store (a live write always persists a message with its
  // parts and a session with its messages), so skipping costs nothing there — but
  // it turns the one catastrophic case into a no-op: a sweep that runs against a
  // half-populated store (an interrupted or reordered migration, an owner table
  // not yet imported) would otherwise read "no owners" as "every child is an
  // orphan" and delete the lot.
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
    const exists = (sql: string) => db.query<{ n: number }, []>(`SELECT EXISTS(${sql}) AS n`).get()!.n === 1
    return {
      parts: exists("SELECT 1 FROM message")
        ? await reap(
            db,
            "SELECT 1 FROM part WHERE NOT EXISTS (SELECT 1 FROM message m WHERE m.id = part.message_id)",
            `DELETE FROM part WHERE NOT EXISTS (SELECT 1 FROM message m WHERE m.id = part.message_id) LIMIT ${SWEEP_CHUNK}`,
          )
        : 0,
      messages: exists("SELECT 1 FROM session")
        ? await reap(
            db,
            "SELECT 1 FROM message WHERE NOT EXISTS (SELECT 1 FROM session s WHERE s.id = message.session_id)",
            `DELETE FROM message WHERE NOT EXISTS (SELECT 1 FROM session s WHERE s.id = message.session_id) LIMIT ${SWEEP_CHUNK}`,
          )
        : 0,
    }
  }

  // Rows per sweep statement. The GC is the lowest-priority work in the process,
  // so what matters is the write lock it holds at once, not how fast it
  // finishes: SQLite has one global write lock and no way to yield a statement
  // already running (bun:sqlite exposes no sqlite3_interrupt), so a bounded
  // statement is the ONLY mechanism that keeps a foreground write from queueing
  // behind the sweep. 500 rows measures ~100ms per slice against a 1.3GB store.
  const SWEEP_CHUNK = 500

  // Delete every row `probe` can find, in `remove`-sized slices, yielding to the
  // event loop between them so foreground writes interleave.
  //
  // The probe runs first and, on the overwhelmingly common empty case, is the
  // ONLY statement executed. It is a read: in WAL a read takes no write lock at
  // all, so a sweep with nothing to do is invisible to every other writer.
  async function reap(db: Database, probe: string, remove: string) {
    if (!db.query<{ n: number }, []>(`SELECT EXISTS(${probe}) AS n`).get()!.n) return 0
    const statement = db.query<void, []>(remove)
    let removed = 0
    while (true) {
      const changes = await retry(() => statement.run().changes)
      removed += changes
      if (changes < SWEEP_CHUNK) return removed
      await Bun.sleep(SWEEP_PAUSE)
    }
  }

  // Idle between slices, so the sweep spends most of its wall-clock time holding
  // no lock and a foreground writer never waits more than one slice.
  const SWEEP_PAUSE = 25

  // The boot trigger, memoized so a restart's re-import of this module does not
  // re-sweep. Tests call sweepOrphans directly.
  export const sweepOrphansOnce = lazy(sweepOrphans)
}
