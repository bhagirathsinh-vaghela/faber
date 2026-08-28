import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { Storage } from "@/storage/storage"
import { fn } from "@/util/fn"
import z from "zod"

export namespace BoxPreference {
  const KEY = ["preference", "boxes"]

  // Per-box-type collapse defaults, keyed by tool/box name. Each mode flag is
  // `true` = collapsed by default, absent/`false` = expanded.
  export const Info = z
    .record(
      z.string(),
      z.object({
        normal: z.boolean().optional(),
        reader: z.boolean().optional(),
      }),
    )
    .meta({
      ref: "BoxPreference",
    })
  export type Info = z.infer<typeof Info>

  const EMPTY: Info = {}

  export const Event = {
    Updated: BusEvent.define("boxes.preference.updated", Info),
  }

  // Each server keeps its own copy of this record, so the reader
  // rename migrates at read time rather than from a script: a record can never
  // be rewritten by a binary that predates the rename. Both flags are optional,
  // so a stale `zen` would otherwise parse clean and read as expanded, silently
  // dropping the saved defaults.
  function migrate(stored: Info) {
    const legacy = stored as Record<string, { normal?: boolean; zen?: boolean; reader?: boolean }>
    const entries = Object.entries(legacy)
    if (!entries.some(([, box]) => "zen" in box)) return undefined
    return Object.fromEntries(entries.map(([box, flags]) => [box, { normal: flags.normal, reader: flags.zen }])) as Info
  }

  export async function get() {
    const stored = await Storage.read<Info>(KEY).catch(() => EMPTY)
    const migrated = migrate(stored)
    if (!migrated) return stored
    await set(migrated)
    return migrated
  }

  export const set = fn(Info, async (input) => {
    await Storage.write(KEY, input)
    GlobalBus.emit("event", {
      directory: "global",
      payload: { type: Event.Updated.type, properties: input },
    })
  })
}
