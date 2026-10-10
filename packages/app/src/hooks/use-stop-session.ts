import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useNavigate, useParams } from "@solidjs/router"

// The full Stop, shared by the session header, the overview and the subagents
// dialog (the composer's Stop aborts only the turn). Aborts the in-flight turn —
// which server-side also tears down the session's ping daemon — and, only when
// the stopped session is the one on screen, returns to the overview home.
// Alt+Q and Ctrl+D fire it from the session header and the overview.
// event.code, not event.key: on macOS Alt+Q composes the glyph "œ", so
// event.key never equals "q"; the physical code is layout/composition proof.
export function isStopKey(event: KeyboardEvent) {
  if (event.metaKey || event.shiftKey) return false
  if (event.altKey && !event.ctrlKey) return event.code === "KeyQ"
  if (event.ctrlKey && !event.altKey) return event.code === "KeyD"
  return false
}

export function useStopSession() {
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const navigate = useNavigate()
  const params = useParams()

  // Returns whether it navigated home (the stopped session was the one on
  // screen), so a caller with extra teardown for that case (e.g. closing an
  // open overlay) can key off the same decision without repeating the rule.
  // Clear the cached liveness BEFORE navigating: the overview classifies rows
  // from that cache, so leaving it to the server's frame renders the session
  // this stop just ended under Live sessions for as long as the round trip and
  // the event batcher take. The abort follows and the server's push confirms it.
  return (sessionID: string, directory: string) => {
    const onScreen = params.id === sessionID
    globalSync.clearLiveness(sessionID, directory)
    if (onScreen) navigate("/", { state: { stopped: sessionID } })
    void sdk.client.session.abort({ sessionID, directory }).catch(() => {})
    return onScreen
  }
}
