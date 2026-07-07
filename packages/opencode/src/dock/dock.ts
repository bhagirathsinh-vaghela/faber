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
    ],
    mobile: ["agent", "model", "cwd", "branch", "context", "cost"],
  }

  // Lives beside skill.json in the global state dir, so every client on one
  // binary shares one layout (same rationale as Skill.favorites).
  const file = path.join(Global.Path.state, "dock.json")

  export async function get() {
    const parsed = await Bun.file(file)
      .json()
      .catch(() => undefined)
    return Config.safeParse(parsed).data ?? defaults
  }

  export async function set(config: Config) {
    await Bun.write(file, JSON.stringify(config))
    GlobalBus.emit("event", {
      directory: "global",
      payload: { type: Event.Updated.type, properties: config },
    })
    return config
  }
}
