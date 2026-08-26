// Wire-level constants for the live event stream, shared so the server that
// emits and the client that judges silence cannot drift apart. A client budget
// that falls below the server's beat condemns healthy connections; one far
// above it leaves a dead connection undetected. Neither side can verify the
// other's number at runtime, so they read the same one.

// Cadence of the server's keepalive frame. Carrier-grade NAT and mobile
// middleboxes tear down a connection carrying no bytes, and the kernel can
// abandon its own TCP probes near the 25s mark, so the beat stays under that.
// It is also well inside WKWebView's 60s idle timeout.
export const HEARTBEAT_MS = 15000

// Silence that proves a connection is dead rather than merely quiet. Three
// beats tolerates the delivery jitter a cellular link adds to any one of them,
// since tearing down a working stream costs a reconnect and a re-bootstrap.
export const IDLE_MS = HEARTBEAT_MS * 3

// Silence tolerated when the page returns to the foreground, where a stream
// suspended by the OS still presents as open and only fresh traffic can tell
// the two apart. Deliberately still longer than a beat: a shorter budget would
// condemn a healthy stream that resumed just after one, turning every app
// switch into a reconnect.
export const RESUME_MS = HEARTBEAT_MS + 5000
