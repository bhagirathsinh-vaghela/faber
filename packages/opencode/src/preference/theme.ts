import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { Storage } from "@/storage/storage"
import { legacyOverrides } from "./overrides"
import { fn } from "@/util/fn"
import z from "zod"

export namespace ThemePreference {
  const KEY = ["preference", "themes"]
  const ACTIVE_KEY = ["preference", "theme-active"]

  // A user theme is a built-in base (baseId) plus the appearance diff layered on
  // top of it. Fields mirror AppearancePreference.Info so a theme is a superset:
  // selecting one replaces the active base and replays these overrides/fonts.
  export const Info = z
    .object({
      id: z.string(),
      name: z.string(),
      baseId: z.string(),
      fontSize: z.number(),
      font: z.string(),
      codeFont: z.string(),
      codeTheme: z.string(),
      diffTheme: z.string(),
      fontWeight: z.number(),
      headingWeight: z.record(z.string(), z.number()),
      overrides: z.object({
        light: z.record(z.string(), z.string()),
        dark: z.record(z.string(), z.string()),
      }),
    })
    .meta({
      ref: "UserTheme",
    })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define("theme.preference.updated", z.object({ themes: Info.array() })),
    ActiveUpdated: BusEvent.define("theme.preference.active-updated", z.object({ active: z.string().nullable() })),
  }

  export async function list(): Promise<Info[]> {
    return Storage.read<Info[]>(KEY)
      .then((themes) => themes.map((theme) => legacyOverrides(theme)))
      .catch(() => [] as Info[])
  }

  async function persist(themes: Info[]) {
    await Storage.write(KEY, themes)
    GlobalBus.emit("event", {
      directory: "global",
      payload: { type: Event.Updated.type, properties: { themes } },
    })
  }

  // Upsert by id so save doubles as create and update.
  export const save = fn(Info, async (input) => {
    const themes = await list()
    const at = themes.findIndex((t) => t.id === input.id)
    if (at === -1) themes.push(input)
    else themes[at] = input
    await persist(themes)
  })

  export const remove = fn(z.object({ id: z.string() }), async (input) => {
    const themes = await list()
    const next = themes.filter((t) => t.id !== input.id)
    if (next.length === themes.length) return
    await persist(next)
    const active = await getActive()
    if (active === input.id) await setActive({ id: null })
  })

  export async function getActive() {
    return Storage.read<string | null>(ACTIVE_KEY).catch(() => null)
  }

  export const setActive = fn(z.object({ id: z.string().nullable() }), async (input) => {
    await Storage.write(ACTIVE_KEY, input.id)
    GlobalBus.emit("event", {
      directory: "global",
      payload: { type: Event.ActiveUpdated.type, properties: { active: input.id } },
    })
  })
}
