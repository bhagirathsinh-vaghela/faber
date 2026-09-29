import { BusEvent } from "@/bus/bus-event"
import z from "zod"

export const Event = {
  // `resumed` says the server replayed every frame published during the gap.
  // `cursor` identifies the newest frame across server restarts so a
  // reconnecting client cannot resume into an unrelated id space.
  Connected: BusEvent.define(
    "server.connected",
    z.object({ resumed: z.boolean().optional(), cursor: z.string().optional() }),
  ),
  Disposed: BusEvent.define("global.disposed", z.object({})),
  // Busy facts for one or more sessions: a single-entry frame from every change
  // (SessionBusy.push), and a snapshot of the open session plus the children
  // with an open debt or a live turn (and one trailing zero entry for a child
  // that just went idle) from the /global/event heal tick while any is active,
  // with one trailing all-zero frame when that clears. Each entry carries its
  // directory to route to the right per-directory store (the frame is global,
  // like recent.updated).
  Busy: BusEvent.define(
    "session.busy",
    z.object({
      sessions: z.record(
        z.string(),
        z.object({
          directory: z.string(),
          turn: z.boolean(),
          subagents: z.number(),
          jobs: z.number(),
        }),
      ),
    }),
  ),
}
