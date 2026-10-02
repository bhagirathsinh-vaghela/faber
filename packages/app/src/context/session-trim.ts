import type { PermissionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { Identifier } from "@opencode-ai/util/identifier"

const cmp = Identifier.compare

const sessionRecentWindow = 4 * 60 * 60 * 1000
const sessionRecentLimit = 50

function sessionUpdatedAt(session: Session) {
  return session.time.updated ?? session.time.created
}

function compareSessionRecent(a: Session, b: Session) {
  const aUpdated = sessionUpdatedAt(a)
  const bUpdated = sessionUpdatedAt(b)
  if (aUpdated !== bUpdated) return bUpdated - aUpdated
  return cmp(a.id, b.id)
}

function takeRecentSessions(sessions: Session[], limit: number, cutoff: number) {
  if (limit <= 0) return [] as Session[]
  const selected: Session[] = []
  const seen = new Set<string>()
  for (const session of sessions) {
    if (!session?.id) continue
    if (seen.has(session.id)) continue
    seen.add(session.id)

    if (sessionUpdatedAt(session) <= cutoff) continue

    const index = selected.findIndex((x) => compareSessionRecent(session, x) < 0)
    if (index === -1) selected.push(session)
    if (index !== -1) selected.splice(index, 0, session)
    if (selected.length > limit) selected.pop()
  }
  return selected
}

// The trimmed list is also the only cache of session records the open page
// reads (the composer's send, the header title), so a session whose transcript
// is held is never trimmed, however old.
export function trimSessions(
  input: Session[],
  options: { limit: number; permission: Record<string, PermissionRequest[]>; message: Record<string, unknown> },
) {
  const limit = Math.max(0, options.limit)
  const cutoff = Date.now() - sessionRecentWindow
  const held = (s: Session) => options.message[s.id] !== undefined
  const all = input
    .filter((s) => !!s?.id)
    .filter((s) => !s.time?.archived)
    .sort((a, b) => cmp(a.id, b.id))

  const roots = all.filter((s) => !s.parentID)
  const children = all.filter((s) => !!s.parentID)

  const base = roots.slice(0, limit)
  const rest = roots.slice(limit)
  const recent = takeRecentSessions(rest, sessionRecentLimit, cutoff)
  const recentIds = new Set(recent.map((s) => s.id))
  const keepRoots = [...base, ...recent, ...rest.filter((s) => held(s) && !recentIds.has(s.id))]

  const keepRootIds = new Set(keepRoots.map((s) => s.id))
  const keepChildren = children.filter((s) => {
    if (held(s)) return true
    if (s.parentID && keepRootIds.has(s.parentID)) return true
    const perms = options.permission[s.id] ?? []
    if (perms.length > 0) return true
    return sessionUpdatedAt(s) > cutoff
  })

  return [...keepRoots, ...keepChildren].sort((a, b) => cmp(a.id, b.id))
}
