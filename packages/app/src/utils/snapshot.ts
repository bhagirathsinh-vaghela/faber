import { openDB, type DBSchema, type IDBPDatabase } from "idb"
import { unwrap } from "solid-js/store"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"

// On-device transcript snapshots. The last-viewed session's tail is
// written to IndexedDB when the tab hides, so the next cold open (every iOS PWA
// launch is one) paints real content from cache before any network fetch, then
// reconciles the gap via the reconnect delta path. IndexedDB, not the
// localStorage-backed persisted() layer: a transcript with tool output runs to
// megabytes and would blow that layer's 8MB bucket and quota-evict.

// Bump on any change to the persisted shape below (Message/Part/Session fields
// this app reads at render). A snapshot stamped with an older VERSION is dropped
// on read rather than merged, so stale data can never crash the transcript. This
// is the hard-discard the raw-IDB path needs, since persisted()'s merge() guard
// does not run here.
const VERSION = 2

// Only the tail is worth persisting: it is what the transcript paints first, and
// the background backfill grows the store to `chunk` (400) messages, which would
// otherwise land here in full.
const TAIL = 40

// Backstop only. The writer refreshes every few seconds while a session is open,
// so a snapshot is normally seconds old; this bounds the cases the writer cannot
// reach — a crash mid-session, a system clock change, a record orphaned by an
// earlier build. Generous on purpose: rejecting a usable snapshot costs the blank
// first paint this whole path exists to avoid.
const MAX_AGE = 12 * 60 * 60 * 1000

// A record younger than this is assumed to have a live writer behind it, so
// pruning leaves it alone. Comfortably above the writer's 5s cadence.
const STALE_AFTER = 30 * 1000

// The writer skips a tail whose fingerprint has not changed, so the fingerprint
// changes at least this often: an idle open session is rewritten often enough
// to stay younger than STALE_AFTER and MAX_AGE.
const REFRESH = 10 * 1000

export type Snapshot = {
  version: number
  writtenAt: number
  directory: string
  sessionID: string
  session: Session
  messages: Message[]
  // Parts keyed by messageID, matching the in-memory store's `part` slice.
  parts: Record<string, Part[]>
}

interface Schema extends DBSchema {
  snapshot: {
    key: string
    value: Snapshot
  }
}

const key = (directory: string, sessionID: string) => `${directory}\n${sessionID}`

const supported = typeof indexedDB !== "undefined"

// Memoize the open so every caller shares one connection. Rejects are swallowed
// by callers (read/write/prune each catch), so a blocked/failed open degrades to
// "no snapshots" rather than throwing into boot.
let db: Promise<IDBPDatabase<Schema>> | undefined
function connect() {
  if (!db)
    db = openDB<Schema>("opencode.snapshot", VERSION, {
      upgrade(database, old) {
        // Any version step drops the whole store: snapshots are a disposable
        // cache, never a source of truth, so migrating them is not worth the
        // risk of loading a shape the current render path can't read.
        if (old > 0 && database.objectStoreNames.contains("snapshot")) database.deleteObjectStore("snapshot")
        database.createObjectStore("snapshot")
      },
    })
  return db
}

// The snapshot is a first-paint device and nothing else: it exists to fill the
// blank frame between a page load and the server's first response. Exactly one
// read is allowed per page load, claimed by the session the URL carried when the
// document opened. Every later navigation — switching sessions, switching
// projects (which remounts the directory layout), reopening the same session —
// renders from the live store, never from disk. Without this the read is
// reachable again after boot, and a hydrate marks the session `hydrated`, which
// downgrades its load to a small delta and can paint a stale tail over a session
// the user just opened. Module scope, so it survives component remounts and
// resets only on a real reload.
let claimed = false

// Not exported: reading disk is only ever legal through claim(), which owns the
// once-per-page-load contract.
async function read(directory: string, sessionID: string) {
  if (!supported) return
  try {
    const value = await connect().then((d) => d.get("snapshot", key(directory, sessionID)))
    // Guard the persisted-data boundary: a snapshot from a prior schema is
    // discarded, not handed to the render path.
    if (!value || value.version !== VERSION) return
    if (!(value.writtenAt <= Date.now() && Date.now() - value.writtenAt < MAX_AGE)) return
    return value
  } catch {
    return
  }
}

export const Snapshot = {
  // The URL's session id at document open, or undefined when the page did not
  // land on a session. Read once here so a later route change cannot pass itself
  // off as the landing session.
  landing:
    typeof location === "undefined" ? undefined : (location.pathname.match(/\/session\/([^/?#]+)/)?.[1] ?? undefined),

  // Read the tail for the session this page load actually landed on. Returns
  // undefined for every other caller, so the live store stays the only source
  // once the app is running.
  async claim(directory: string, sessionID: string): Promise<Snapshot | undefined> {
    if (claimed) return
    if (sessionID !== Snapshot.landing) return
    claimed = true
    return read(directory, sessionID)
  },

  async write(snapshot: Snapshot) {
    if (!supported) return
    // idb transactions auto-close once control returns to the event loop with no
    // pending request, so the value is fully built here and the transaction body
    // only awaits IDB work.
    try {
      const d = await connect()
      const tx = d.transaction("snapshot", "readwrite")
      await tx.store.put(snapshot, key(snapshot.directory, snapshot.sessionID))
      await tx.done
    } catch {}
  },

  build(directory: string, session: Session, messages: Message[], parts: Record<string, Part[]>): Snapshot {
    const tail = messages.slice(-TAIL)
    // Store slices are SolidJS reactive proxies, which IndexedDB's structured
    // clone rejects (DataCloneError). unwrap() returns the raw object graph.
    const slice: Record<string, Part[]> = {}
    for (const message of tail) {
      const p = parts[message.id]
      if (p) slice[message.id] = unwrap(p)
    }
    return {
      version: VERSION,
      writtenAt: Date.now(),
      directory,
      sessionID: session.id,
      session: unwrap(session),
      messages: tail.map((message) => unwrap(message)),
      parts: slice,
    }
  },

  // The tail a session's store currently holds, as a cheap value the caller can
  // compare against the last one it wrote. A streaming turn mutates parts under a
  // stable message id, and a completing message mutates in place, so the newest
  // id alone would read unchanged for a whole turn.
  fingerprint(messages: Message[], parts: Record<string, Part[]>, now = Date.now()) {
    const last = messages[messages.length - 1]
    if (!last) return ""
    const time = last.time as { created: number; completed?: number }
    return [
      last.id,
      messages.length,
      parts[last.id]?.length ?? 0,
      time.completed ?? time.created,
      Math.floor(now / REFRESH),
    ].join(":")
  },

  // Drop every record outside `keep`. The caller's keep-set is the overview's
  // attention bucket, so a session that is neither working, pinging, nor unseen
  // surrenders its snapshot — which also makes an explicit stop evict it on every
  // client, including one that was offline when the stop happened.
  //
  // Only records older than one writer cadence are eligible. Tabs in the SAME
  // browser share this store, and each keeps its own open session's tail fresh
  // while its attention view may not include another tab's session; without the
  // age floor a pruning tab repeatedly deletes a record the other tab is actively
  // maintaining, so the two fight over the same key for as long as both are open.
  // A snapshot being written right now is by definition young, so skipping the
  // young ones costs nothing and leaves the steady state to whichever tab owns
  // that session.
  async prune(keep: Set<string>) {
    if (!supported) return
    try {
      const d = await connect()
      const tx = d.transaction("snapshot", "readwrite")
      const stale: string[] = []
      for (const entry of await tx.store.getAll()) {
        if (keep.has(entry.sessionID)) continue
        if (Date.now() - entry.writtenAt < STALE_AFTER) continue
        stale.push(key(entry.directory, entry.sessionID))
      }
      await Promise.all([...stale.map((k) => tx.store.delete(k)), tx.done])
    } catch {}
  },
}
