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
  // Level-triggered busy reconcile, pushed on the per-connection 5s tick in
  // /global/event (quiescence-gated: emitted only while the connection's scoped
  // subtree has a busy session, plus one trailing all-idle when it clears). The
  // map is authoritative for exactly the connection's interest set — a session
  // in scope but absent from the map is idle. Sparse (busy-only) so it stays
  // tiny; the client replaces its scoped slice wholesale, self-healing any drop.
  Busy: BusEvent.define(
    "session.busy",
    z.object({
      // Full snapshot of EVERY session in the connection's interest scope, with
      // explicit facts (not sparse) — so the client is authoritative by
      // construction: it writes each entry into its directory store directly, no
      // idle-by-omission inference and no cross-directory clear. Each entry
      // carries its directory to route to the right per-directory store (the
      // frame is global, like recent.updated). Scope is a subtree — tiny.
      sessions: z.record(
        z.string(),
        z.object({
          directory: z.string(),
          busy: z.boolean(),
          busySelf: z.boolean(),
          busyDescendant: z.boolean(),
        }),
      ),
    }),
  ),
}
