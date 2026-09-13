import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { Storage } from "@/storage/storage"
import { fn } from "@/util/fn"
import z from "zod"

export namespace VoicePreference {
  const KEY = ["preference", "voice"]

  // A friendly read-aloud speaker name (e.g. af_bella). Server-owned so any
  // client that picks a voice sets it for every client of the server, and
  // null means no preference, deferring to the config default then the sidecar.
  export const Info = z
    .object({
      name: z.string().nullable(),
    })
    .meta({
      ref: "VoicePreference",
    })
  export type Info = z.infer<typeof Info>

  const EMPTY: Info = { name: null }

  export const Event = {
    Updated: BusEvent.define("voice.preference.updated", Info),
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
