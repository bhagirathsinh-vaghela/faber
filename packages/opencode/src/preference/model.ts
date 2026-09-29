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
    })
    .meta({
      ref: "ModelPreference",
    })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define("model.preference.updated", Info),
  }

  // Parsed per field on read, so a key the schema dropped never reaches a
  // client and one bad list does not empty the other. A fresh object each
  // call, so a caller that mutates it cannot corrupt a later read.
  const Read = z.object({
    user: User.array().catch([]),
    recent: ModelKey.array().catch([]),
  })
  export async function get(): Promise<Info> {
    const stored = await Storage.read<unknown>(KEY).catch(() => undefined)
    return Read.parse(stored ?? {})
  }

  export const set = fn(Info, async (input) => {
    await Storage.write(KEY, input)
    GlobalBus.emit("event", {
      directory: "global",
      payload: { type: Event.Updated.type, properties: input },
    })
  })
}
