// `busy` is the effective flag (own turn OR any in-flight descendant subtask).
// `busySelf` (own turn only) is optional here so isAlive stays on the single
// effective boolean; only the animation-picking components read busySelf,
// deriving "busy because of a descendant" as `busy && !busySelf`.
//
// Liveness is machine-bounded: work the server is actively doing. A turn in
// flight, an armed ping daemon, a background job still running, and a spawned
// helper that owes this session a report all qualify. The last two are work the
// session WAITS on rather than executes, so neither reaches `busy`, and leaving
// them out drops a session out of the live bucket while its result is still
// coming. That governs SSE subscription scope and transcript eviction, so the
// session evicted here is the one the result lands in.
//
// `unseen` is deliberately NOT part of it: that is a human-cleared read
// receipt, so folding it in would let an unread backlog drive the same two.
export type Flags = {
  busy: boolean
  busySelf?: boolean
  busyHelper?: boolean
  busyJob?: boolean
  pingAt?: number
}

export function isAlive(session: Flags) {
  return session.busy || session.busyHelper === true || session.busyJob === true || session.pingAt !== undefined
}
