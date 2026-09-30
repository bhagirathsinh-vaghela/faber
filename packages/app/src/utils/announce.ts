import type { Session } from "@opencode-ai/sdk/v2/client"
import { Binary } from "@opencode-ai/util/binary"

// The sync store lists root sessions only, so a subagent whose turn ends is
// usually absent from it and has to be looked up before it can be told apart
// from a root. Resolves undefined for a subagent, or for a session the server
// no longer has.
export async function root(
  sessions: Session[],
  sessionID: string,
  lookup: (sessionID: string) => Promise<Session | undefined>,
) {
  const found = Binary.search(sessions, sessionID, (session) => session.id)
  const session = found.found ? sessions[found.index] : await lookup(sessionID)
  return session && !session.parentID ? session : undefined
}
