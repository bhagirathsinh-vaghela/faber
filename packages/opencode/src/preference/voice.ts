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
      // Bumped by every set, so a client can tell a newer value from an older one
      // whichever channel delivers it. Absent on a value stored before versions.
      version: z.number().int().nonnegative().optional(),
    })
    .meta({
      ref: "VoicePreference",
    })
  export type Info = z.infer<typeof Info>

  // What a client sends: the version is the server's to assign.
  export const Input = Info.pick({ name: true })

  export const Event = {
    Updated: BusEvent.define("voice.preference.updated", Info),
  }

  // With nothing stored (never set, or the file lost) the answer is versioned
  // at the clock, like `set`'s floor, so a client holding an older version
  // takes the loss instead of keeping a voice the server no longer has.
  export async function get(): Promise<Info> {
    return Storage.read<Info>(KEY).catch(() => ({ name: null, version: Date.now() }))
  }

  // The read and the write happen under one lock (Storage.reconcile), so two
  // sets never read the same version. The version is floored at the clock, so
  // a lost file restarts it above any version a client holds, unless the clock
  // has since moved back.
  export const set = fn(Input, async (input) => {
    const value = await Storage.reconcile<Info>(KEY, (stored) => ({
      name: input.name,
      version: Math.max((stored?.version ?? 0) + 1, Date.now()),
    }))
    GlobalBus.emit("event", {
      directory: "global",
      payload: { type: Event.Updated.type, properties: value },
    })
    return value
  })
}
