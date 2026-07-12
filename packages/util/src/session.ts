// `busy` is the effective flag (own turn OR any in-flight descendant subtask).
// `busySelf` (own turn only) is optional here so isAlive/needsAttention stay on
// the single effective boolean; only the animation-picking components read
// busySelf, deriving "busy because of a descendant" as `busy && !busySelf`.
export type Flags = { busy: boolean; busySelf?: boolean; unseen?: boolean; pingAt?: number }

export function isAlive(session: Flags) {
  return session.busy || session.pingAt !== undefined
}

export function needsAttention(session: Flags) {
  return isAlive(session) || !!session.unseen
}
