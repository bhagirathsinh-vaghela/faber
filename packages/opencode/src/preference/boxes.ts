import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { Storage } from "@/storage/storage"
import { fn } from "@/util/fn"
import z from "zod"

export namespace BoxPreference {
  const KEY = ["preference", "boxes"]

  // Per-box-type collapse defaults, keyed by tool/box name. Each mode flag is
  // `true` = collapsed by default, absent/`false` = expanded. The modes are the
  // app's BoxMode: the normal transcript and the read-focused reader view.
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

  export async function get() {
    return Storage.read<Info>(KEY).catch(() => EMPTY)
  }

  export const set = fn(Info, async (input) => {
    await Storage.write(KEY, input)
    GlobalBus.emit("event", {
      directory: "global",
      payload: { type: Event.Updated.type, properties: input },
    })
  })
}
