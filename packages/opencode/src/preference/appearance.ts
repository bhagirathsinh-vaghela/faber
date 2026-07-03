import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { Storage } from "@/storage/storage"
import { fn } from "@/util/fn"
import z from "zod"

export namespace AppearancePreference {
  const KEY = ["preference", "appearance"]

  export const Info = z
    .object({
      fontSize: z.number(),
      font: z.string(),
      codeFont: z.string(),
      codeTheme: z.string(),
      diffTheme: z.string(),
      fontWeight: z.number(),
      headingWeight: z.record(z.string(), z.number()),
      // Per-mode CSS custom-property overrides: { light: {...}, dark: {...} }.
      overrides: z.object({
        light: z.record(z.string(), z.string()),
        dark: z.record(z.string(), z.string()),
      }),
    })
    .meta({
      ref: "AppearancePreference",
    })
  export type Info = z.infer<typeof Info>

  const EMPTY: Info = {
    fontSize: 13,
    font: "jetbrains-mono",
    codeFont: "jetbrains-mono",
    codeTheme: "github-dark",
    diffTheme: "github-dark",
    fontWeight: 400,
    headingWeight: { "1": 700, "2": 700, "3": 700, "4": 700, "5": 700, "6": 700 },
    overrides: { light: {}, dark: {} },
  }

  export const Event = {
    Updated: BusEvent.define("appearance.preference.updated", Info),
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
