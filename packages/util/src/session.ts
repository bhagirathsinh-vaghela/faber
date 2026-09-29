// Liveness is machine-bounded: work the server is actively doing. A turn in
// flight, an open subagent or background job this session called and waits on,
// and an armed ping daemon all qualify. That governs SSE subscription scope and
// transcript eviction, so a caller waiting on a debt stays live and the result
// lands in a session that was never evicted.
//
// `unseen` is deliberately NOT part of it: that is a human-cleared read
// receipt, so folding it in would let an unread backlog drive the same two.
export type Flags = {
  turn: boolean
  subagents: number
  jobs: number
  pingAt?: number
}

export function isAlive(session: Flags) {
  return session.turn || session.subagents > 0 || session.jobs > 0 || session.pingAt !== undefined
}
