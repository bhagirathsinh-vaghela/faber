import { EventEmitter } from "events"

export const GlobalBus = new EventEmitter<{
  event: [
    {
      directory?: string
      payload: any
    },
  ]
}>()

// One listener per connected SSE client. Many devices/tabs on one server is
// normal here, so the default cap of 10 would fire a spurious leak warning.
GlobalBus.setMaxListeners(0)

// Per-connection event scoping. Each SSE client optionally
// registers an "interest" — the sessions its current screen actually needs.
// The /global/event handler consults this to drop the streaming firehose of
// sessions the client isn't looking at.
//
// FAIL-OPEN is the contract: a connection with no registered interest receives
// EVERYTHING (today's behavior). Filtering only applies once a client has
// explicitly registered via POST /global/subscribe. This is what lets the
// server-side filter ship before any client wiring — an un-subscribing client
// is unaffected.
export namespace GlobalInterest {
  type Interest = { directory?: string; sessions: Set<string> }
  const registry = new Map<string, Interest>()

  export function set(connectionID: string, directory: string | undefined, sessions: string[]) {
    registry.set(connectionID, { directory, sessions: new Set(sessions) })
  }

  export function clear(connectionID: string) {
    registry.delete(connectionID)
  }

  // Session-scoped event types: only meaningful to a client viewing that
  // session, and each carries a sessionID the extractor below can find. Any
  // type NOT in this set is always-global and passes unconditionally.
  // permission.*/question.* stay global on purpose: they are user-attention
  // signals that must surface for any session, including an idle one outside
  // the connection's interest set, so scoping them would silently drop the
  // "agent is blocked waiting on you" prompt.
  const scoped = new Set([
    "message.updated",
    "message.removed",
    "message.part.updated",
    "message.part.removed",
    "session.diff",
    "session.error",
    "session.compacted",
    "todo.updated",
  ])

  // Pull the sessionID out of a payload regardless of where the event nests it
  // (top-level, .part, or .info). Returns undefined when none is found, which
  // makes the event fail-open (passes) — misclassification can only over-send,
  // never drop.
  function sessionOf(payload: any): string | undefined {
    const p = payload?.properties
    return p?.sessionID ?? p?.part?.sessionID ?? p?.info?.sessionID
  }

  // Should this connection receive this event? Fail-open at every uncertain
  // step: unknown connection, unregistered interest, non-scoped type, or a
  // scoped event whose sessionID we can't read all pass through.
  export function wants(connectionID: string, payload: any): boolean {
    const interest = registry.get(connectionID)
    if (!interest) return true
    const type = payload?.type
    if (!scoped.has(type)) return true
    const session = sessionOf(payload)
    if (!session) return true
    return interest.sessions.has(session)
  }
}
