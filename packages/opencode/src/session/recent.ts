import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { Storage } from "@/storage/storage"
import { lazy } from "@/util/lazy"
import z from "zod"

// An in-memory LRU of the sessions touched by a real turn, ordered by last
// activity. Server-owned so every client renders the same overview; persisted
// (lazily) so it survives a restart. Reads never scan the session store — the
// list is capped, held in memory, and written through to disk on a debounce.
// Lossy on purpose: a crash loses at most the last few touches, which only
// reorders a handful of recent entries.
export namespace SessionRecent {
  const KEY = ["recent"]
  const LIMIT = 50
  const FLUSH_MS = 1000

  export const Entry = z
    .object({
      sessionID: z.string(),
      directory: z.string(),
      title: z.string(),
      // Last real-turn timestamp — the same signal that stamps session
      // lastActivity. Pings and views never reach here.
      updated: z.number(),
    })
    .meta({ ref: "RecentSession" })
  export type Entry = z.infer<typeof Entry>

  export const Event = {
    Updated: BusEvent.define("recent.updated", z.object({ entries: Entry.array() })),
  }

  const entries = new Map<string, Entry>()

  const hydrate = lazy(async () => {
    const stored = await Storage.read<Entry[]>(KEY).catch(() => [] as Entry[])
    for (const entry of stored) entries.set(entry.sessionID, entry)
  })

  const sorted = () => [...entries.values()].sort((a, b) => b.updated - a.updated)

  let timer: ReturnType<typeof setTimeout> | undefined
  function flush() {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      void Storage.write(KEY, sorted())
    }, FLUSH_MS)
  }

  function publish() {
    GlobalBus.emit("event", {
      directory: "global",
      payload: { type: Event.Updated.type, properties: { entries: sorted() } },
    })
  }

  export async function list() {
    await hydrate()
    return sorted()
  }

  // A real turn touched this session: move it to the front and evict the oldest
  // past the cap. Re-inserting keeps the map's own order irrelevant — sorted()
  // orders by updated — but the delete+set keeps eviction simple.
  export async function touch(input: Entry) {
    await hydrate()
    entries.delete(input.sessionID)
    entries.set(input.sessionID, input)
    if (entries.size > LIMIT) {
      const drop = sorted().slice(LIMIT)
      for (const entry of drop) entries.delete(entry.sessionID)
    }
    flush()
    publish()
  }

  export async function remove(sessionID: string) {
    await hydrate()
    if (!entries.delete(sessionID)) return
    flush()
    publish()
  }
}
