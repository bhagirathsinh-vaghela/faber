import { createSignal, onCleanup } from "solid-js"

// Every control in this app fires its action on `click`, on every platform.
// `click` is the ACTIVATION event, not a mouse event: it fires for a mouse
// click, a finger tap, Enter/Space on a focused button, and a screen reader's
// virtual cursor. Binding an action to `pointerdown` loses the last two outright
// and buys a hit-testing hazard, because `click` is targeted at dispatch time:
// a press-time handler that mutates the DOM hands the release to whatever slid
// into those coordinates, and `preventDefault` on `pointerdown` cannot cancel
// that click (the Pointer Events spec offers no way to). Press-time events are
// for GESTURE TRACKING (drag, visual press state), never for firing an action.
//
// Two things push callers toward a press-time action; both have a correct answer
// here, so no component hand-rolls one:
//
//   focus theft  — a button that steals focus blurs whatever the user was
//                  typing in, and on iOS that blur consumes the tap that would
//                  have become the click. `preserveFocus` cancels the focus
//                  shift without touching the click, since `click` is not a
//                  default action of `mousedown`.
//   user gesture — raising the soft keyboard needs a synchronous `focus()`
//                  inside the live user-activation window, which is gone by
//                  click time on Android. `gestureAction` is the ONLY sanctioned
//                  reason to act on press, and it exists so those call sites are
//                  greppable rather than indistinguishable from an ordinary tap.

// Keep focus where it is when this control is pressed. `preventDefault` on
// `mousedown` cancels the browser's focus shift (and the blur that follows it)
// while leaving the click intact, so pair this with a normal `onClick`.
export function preserveFocus() {
  return { onMouseDown: (e: MouseEvent) => e.preventDefault() }
}

// Act on press, for the ONE case that requires it: an API gated on transient
// user activation, which a `click` handler no longer holds. Raising the soft
// keyboard via a programmatic focus() is the only such action in this app.
//
// The trailing click cannot be cancelled, so the whole release sequence is
// swallowed on the way out — a `mouseup`/`click` that lands normally pulls focus
// off the element the action just focused, dropping the keyboard again — and a
// time latch drops a repeat pointerdown from the same tap. Do NOT reach for this
// to make a tap feel faster: the 300ms click delay it would be dodging no longer
// exists on a viewport-optimized page.
export function gestureAction(action: (e: Event) => void) {
  let last = 0
  return {
    onPointerDown: (e: PointerEvent) => {
      const now = e.timeStamp || performance.now()
      if (now - last < 350) return
      last = now
      e.preventDefault()
      action(e)
    },
    onPointerUp: (e: PointerEvent) => e.preventDefault(),
    onMouseDown: (e: MouseEvent) => e.preventDefault(),
    onClick: (e: MouseEvent) => e.preventDefault(),
  }
}

// Reactive "is this a touch-primary device" signal. Coarse pointer with no hover
// targets phones/tablets, not touchscreen laptops that still drive a trackpad.
// Gates soft-keyboard suppression: the question is "will focusing an input raise
// the OS keyboard", which UA sniffing gets wrong (iPad reports as desktop Safari).
export function createCoarsePointer() {
  const query = window.matchMedia("(hover: none) and (pointer: coarse)")
  const [coarse, setCoarse] = createSignal(query.matches)
  const handler = () => setCoarse(query.matches)
  query.addEventListener("change", handler)
  onCleanup(() => query.removeEventListener("change", handler))
  return coarse
}

// Reactive "is this an installed standalone PWA" signal. In standalone display
// mode there's no browser chrome, so no address bar and no reload button; a
// standalone-only in-app reload control fills that gap. display-mode covers
// Android/Chromium and desktop installs; navigator.standalone is the iOS Safari
// fallback (it predates and doesn't report the display-mode query).
export function createStandalone() {
  const query = window.matchMedia("(display-mode: standalone)")
  const ios = () => (navigator as unknown as { standalone?: boolean }).standalone === true
  const [standalone, setStandalone] = createSignal(query.matches || ios())
  const handler = () => setStandalone(query.matches || ios())
  query.addEventListener("change", handler)
  onCleanup(() => query.removeEventListener("change", handler))
  return standalone
}
