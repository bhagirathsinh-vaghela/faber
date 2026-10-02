import type { Session } from "@opencode-ai/sdk/v2/client"
import { Binary } from "@opencode-ai/util/binary"

// Whether the done sound plays: not for the session open here in a tab that is
// visible and focused, where the screen already shows the turn ended. The same
// test the OS notification uses to stay quiet. Only the done sound asks it: an
// error, a question or a stop sounds even on screen, since each needs acting on.
export function audible(open: boolean, page: Pick<Document, "visibilityState" | "hasFocus"> = document) {
  return !(open && page.visibilityState === "visible" && page.hasFocus())
}

// A finished turn is announced for a root session, or for whichever session
// this client has open (a subagent being watched counts). The sync store lists
// root sessions only, so a subagent is usually absent from it and has to be
// looked up before it can be told apart from a root. Resolves undefined when
// the turn is not announced, or for a session the server no longer has.
export async function announced(
  sessions: Session[],
  sessionID: string,
  open: boolean,
  lookup: (sessionID: string) => Promise<Session | undefined>,
) {
  const found = Binary.search(sessions, sessionID, (session) => session.id)
  const session = found.found ? sessions[found.index] : await lookup(sessionID)
  return session && (open || !session.parentID) ? session : undefined
}
