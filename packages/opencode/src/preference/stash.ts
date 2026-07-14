import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { Storage } from "@/storage/storage"
import { fn } from "@/util/fn"
import z from "zod"

export namespace Stash {
  const KEY = ["preference", "stash"]
  const MAX_ENTRIES = 50

  // The prompt is a client-side content-part array. The server never inspects
  // it, so it stays an opaque passthrough blob rather than coupling to the web
  // ContentPart union. `context` is the same: an opaque snapshot of the prompt's
  // attached context items (line-comments), optional so old entries pop fine.
  export const Entry = z
    .object({
      prompt: z.any().array(),
      context: z.any().array().optional(),
      timestamp: z.number(),
    })
    .meta({
      ref: "StashEntry",
    })
  export type Entry = z.infer<typeof Entry>

  export const Event = {
    Updated: BusEvent.define("stash.updated", z.object({ entries: Entry.array() })),
  }

  // Global, server-owned, and persisted: one shared pool for every client that
  // survives a restart, syncing live over the stash.updated event.
  export async function list() {
    return Storage.read<Entry[]>(KEY).catch(() => [] as Entry[])
  }

  async function save(entries: Entry[]) {
    await Storage.write(KEY, entries)
    GlobalBus.emit("event", {
      directory: "global",
      payload: { type: Event.Updated.type, properties: { entries } },
    })
  }

  export const push = fn(Entry, async (input) => {
    const entries = await list()
    entries.push(input)
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
    await save(entries)
  })

  export const removeAt = fn(z.object({ index: z.number() }), async (input) => {
    const entries = await list()
    if (input.index < 0 || input.index >= entries.length) return
    entries.splice(input.index, 1)
    await save(entries)
  })
}
