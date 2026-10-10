import { BusEvent } from "@/bus/bus-event"
import z from "zod"
import { Flag } from "../flag/flag"

declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
}

export namespace Installation {
  export const Event = {
    Updated: BusEvent.define(
      "installation.updated",
      z.object({
        version: z.string(),
      }),
    ),
    UpdateAvailable: BusEvent.define(
      "installation.update-available",
      z.object({
        version: z.string(),
      }),
    ),
  }

  export function isPreview() {
    return CHANNEL !== "latest"
  }

  export function isLocal() {
    return CHANNEL === "local"
  }

  export const VERSION = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
  export const CHANNEL = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
  export const USER_AGENT = `opencode/${CHANNEL}/${VERSION}/${Flag.OPENCODE_CLIENT}`
}
