// `busy` is the effective flag (own turn OR any in-flight descendant subtask).
// `busySelf` (own turn only) is optional here so isAlive stays on the single
// effective boolean; only the animation-picking components read busySelf,
// deriving "busy because of a descendant" as `busy && !busySelf`.
//
// Liveness is machine-bounded — a turn in flight or an armed ping daemon, both
// backed by work the server is actively doing. `unseen` is deliberately NOT
// part of it: that is a human-cleared read receipt, so folding it in would let
// an unread backlog drive SSE subscription scope and transcript eviction.
export type Flags = { busy: boolean; busySelf?: boolean; pingAt?: number }

export function isAlive(session: Flags) {
  return session.busy || session.pingAt !== undefined
}
