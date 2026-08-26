// A suspicious environment signal — a network online/offline flap, or the page
// returning to the foreground — is a reason to CHECK the stream, never to tear it
// down. navigator.onLine is documented-unreliable (MDN: "inherently unreliable")
// and fires online/offline spuriously on multi-interface / VPN machines, so
// aborting the live stream on the signal kills a healthy connection on a flap
// that changed nothing.
//
// Liveness is already tracked by the read-liveness watchdog: armed while a stream
// is attached, unset while the loop is between attempts. With no stream attached
// the signal is the legitimate recovery case (reconnect now, do not serve out a
// backoff scheduled against a link that just returned). With one attached, verify
// instead — a dead stream stops delivering and a shortened deadline catches it,
// while a healthy stream keeps re-arming that deadline and is never torn down.
export type Revalidation = "reconnect" | "verify"

export function revalidate(streamLive: boolean): Revalidation {
  if (streamLive) return "verify"
  return "reconnect"
}
