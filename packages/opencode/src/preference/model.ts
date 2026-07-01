import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { Storage } from "@/storage/storage"
import { fn } from "@/util/fn"
import z from "zod"

export namespace ModelPreference {
  const KEY = ["preference", "model"]

  export const ModelKey = z.object({
    providerID: z.string(),
    modelID: z.string(),
  })

  export const User = ModelKey.extend({
    visibility: z.enum(["show", "hide"]),
    favorite: z.boolean().optional(),
  })

  export const Info = z
    .object({
      user: User.array(),
      recent: ModelKey.array(),
      variant: z.record(z.string(), z.string().optional()),
    })
    .meta({
      ref: "ModelPreference",
    })
  export type Info = z.infer<typeof Info>

  const EMPTY: Info = { user: [], recent: [], variant: {} }

  export const Event = {
    Updated: BusEvent.define("model.preference.updated", Info),
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
