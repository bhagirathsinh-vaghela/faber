import { useGlobalSDK } from "@/context/global-sdk"
import { useNavigate, useParams } from "@solidjs/router"

// The one Stop action, shared by every stop control (the prompt-input stop
// button, the session header, the overview). Aborts the in-flight turn — which
// server-side also tears down the session's ping daemon — and, only when the
// stopped session is the one on screen, returns to the overview home.
export function useStopSession() {
  const sdk = useGlobalSDK()
  const navigate = useNavigate()
  const params = useParams()

  // Returns whether it navigated home (the stopped session was the one on
  // screen), so a caller with extra teardown for that case (e.g. closing an
  // open overlay) can key off the same decision without repeating the rule.
  // Navigate first so the view leaves immediately, then tear the session down
  // (abort the turn, which server-side also stops the ping daemon).
  return (sessionID: string, directory: string) => {
    const onScreen = params.id === sessionID
    if (onScreen) navigate("/", { state: { stopped: sessionID } })
    void sdk.client.session.abort({ sessionID, directory }).catch(() => {})
    return onScreen
  }
}
