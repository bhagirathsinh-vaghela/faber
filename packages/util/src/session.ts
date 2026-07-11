export type Flags = { busy: boolean; unseen?: boolean; pingAt?: number }

export function isAlive(session: Flags) {
  return session.busy || session.pingAt !== undefined
}

export function needsAttention(session: Flags) {
  return isAlive(session) || !!session.unseen
}
