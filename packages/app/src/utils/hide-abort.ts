// On desktop Chrome, `visibilityState === "hidden"` includes "another window is
// in front of mine" (WebContents occlusion). That is ordinary desktop multitasking
// and tearing the SSE stream down there costs a reconnect and a REST resync for
// nothing. On touch-primary devices the abort is still correct: iOS kills
// backgrounded sockets, and holding one open burns battery for events nothing
// paints. The heartbeat + watchdog still catch a genuinely dead desktop stream.
export function shouldAbort(hidden: boolean, coarse: boolean) {
  if (!hidden) return false
  return coarse
}
