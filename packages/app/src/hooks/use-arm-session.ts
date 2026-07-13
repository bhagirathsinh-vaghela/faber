import { useGlobalSDK } from "@/context/global-sdk"

// Toggle a session's persisted keep-warm intent, in place (never navigates —
// unlike stop, you stay on the view). Arm declares the "keep this session's
// cache warm" intent and starts the ping daemon; disarm clears the intent and
// stops it. Arm is the explicit-open verb: an intentional open (sidebar/overview
// click, new session) or the button calls it. A plain fetch (reload, reconnect)
// does NOT, so it can't resurrect a stopped session. Disarm here goes through
// ping/stop rather than the abort path so it clears intent without leaving the
// session view.
export function useArmSession() {
  const sdk = useGlobalSDK()
  return {
    arm(sessionID: string, directory: string) {
      void sdk.client.session.arm({ sessionID, directory }).catch(() => {})
    },
    disarm(sessionID: string, directory: string) {
      void sdk.client.session.pingStop({ sessionID, directory }).catch(() => {})
    },
  }
}
