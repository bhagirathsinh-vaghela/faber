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
const VERSION = 1

export type Snapshot = {
  version: number
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
// by callers (get/put/remove each catch), so a blocked/failed open degrades to
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

export const Snapshot = {
  async read(directory: string, sessionID: string): Promise<Snapshot | undefined> {
    if (!supported) return
    try {
      const value = await connect().then((d) => d.get("snapshot", key(directory, sessionID)))
      // Guard the persisted-data boundary: a snapshot from a prior schema is
      // discarded, not handed to the render path.
      if (!value || value.version !== VERSION) return
      return value
    } catch {
      return
    }
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

  async remove(directory: string, sessionID: string) {
    if (!supported) return
    try {
      await connect().then((d) => d.delete("snapshot", key(directory, sessionID)))
    } catch {}
  },

  build(directory: string, session: Session, messages: Message[], parts: Record<string, Part[]>): Snapshot {
    // Store slices are SolidJS reactive proxies, which IndexedDB's structured
    // clone rejects (DataCloneError). unwrap() returns the raw object graph.
    const slice: Record<string, Part[]> = {}
    for (const message of messages) {
      const p = parts[message.id]
      if (p) slice[message.id] = unwrap(p)
    }
    return {
      version: VERSION,
      directory,
      sessionID: session.id,
      session: unwrap(session),
      messages: unwrap(messages),
      parts: slice,
    }
  },
}
