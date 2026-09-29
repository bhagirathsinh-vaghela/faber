import z from "zod"
import path from "path"
import { Global } from "@/global"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"

export namespace Dock {
  // Per-surface sets of VISIBLE field IDs from the canonical registry.
  // Order is canonical at render time, so config carries presence
  // only — no order. Two independent layouts: the app picks one by screen
  // width. Shared by the live dock and the per-message footer.
  export const Config = z.object({
    desktop: z.string().array(),
    mobile: z.string().array(),
  })
  export type Config = z.infer<typeof Config>

  // Broadcast on every write so all open clients live-update their dock,
  // mirroring model.preference.updated. Registered on import (server routes pull
  // in this module), so it lands in the generated Event union automatically.
  export const Event = {
    Updated: BusEvent.define("dock.updated", Config),
  }

  // Defaults: desktop shows everything, mobile shows the running-out /
  // costing essentials. Used when no config file exists yet.
  export const defaults: Config = {
    desktop: [
      "agent",
      "model",
      "variant",
      "duration",
      "cwd",
      "branch",
      "context",
      "cached",
      "cache-write",
      "next-turn",
      "input",
      "output",
      "session-cache-write",
      "cost",
      "mcp",
      "auto-accept",
      "back-forward",
      "terminal",
      "review",
    ],
    mobile: ["agent", "model", "cwd", "branch", "context", "cost", "mcp", "review"],
  }

  // Lives beside skill.json in the global state dir, so every client on one
  // binary shares one layout (same rationale as Skill.favorites).
  const file = path.join(Global.Path.state, "dock.json")

  // The config stores presence only, so in a bare two-array file an id
  // introduced after the write is indistinguishable from one the user hid.
  const File = Config.extend({ known: z.string().array().optional() })
  const registry = [...new Set([...defaults.desktop, ...defaults.mobile])]

  export async function get() {
    const parsed = await Bun.file(file)
      .json()
      .catch(() => undefined)
    const stored = File.safeParse(parsed).data
    if (!stored) return defaults
    // A legacy file carries no `known`; treat everything current as seen so
    // deliberate hides survive.
    const known = new Set(stored.known ?? registry)
    // An id the registry no longer has names a field that was removed.
    const grow = (surface: "desktop" | "mobile") => [
      ...stored[surface].filter((id) => registry.includes(id)),
      ...defaults[surface].filter((id) => !known.has(id) && !stored[surface].includes(id)),
    ]
    return { desktop: grow("desktop"), mobile: grow("mobile") }
  }

  export async function set(config: Config) {
    await Bun.write(file, JSON.stringify({ desktop: config.desktop, mobile: config.mobile, known: registry }))
    GlobalBus.emit("event", {
      directory: "global",
      payload: { type: Event.Updated.type, properties: config },
    })
    return config
  }
}
