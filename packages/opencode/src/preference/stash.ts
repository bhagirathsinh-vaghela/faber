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

  async function save(change: (entries: Entry[]) => Entry[]) {
    const entries = await Storage.reconcile<Entry[]>(KEY, (stored) => change(stored ?? []))
    GlobalBus.emit("event", {
      directory: "global",
      payload: { type: Event.Updated.type, properties: { entries } },
    })
  }

  export const push = fn(Entry, (input) => save((entries) => [...entries, input].slice(-MAX_ENTRIES)))

  export const removeAt = fn(z.object({ index: z.number() }), (input) =>
    save((entries) => entries.filter((_, index) => index !== input.index)),
  )
}
