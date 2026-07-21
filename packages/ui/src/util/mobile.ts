import { createSignal, onCleanup } from "solid-js"

// One physical activation (a mouse click OR a touch tap) must fire the action
// exactly once. The trap: an element that acts on `pointerdown` still receives a
// browser-synthesized `click` from the same tap, and `preventDefault()` on
// `pointerdown` does NOT cancel that click (per the Pointer Events spec there is
// no way to). Any element wired to both a pointerdown action and a native click
// (an `onClick`, or a `type="submit"` inside a form) therefore double-fires on
// touch. This helper is the single correct wiring, so no caller hand-rolls it:
//
//   <button {...tapAction(coarse, () => doThing())} />
//
// Desktop (fine pointer): bind the action to `onClick` — the browser already
// fires it once for mouse and touch, nothing to dedupe.
//
// Touch (coarse pointer): bind the action to `onPointerDown` (the trusted first
// touch — some actions, like raising the iOS soft keyboard, only count as a user
// gesture there) and swallow the whole synthesized release sequence
// (`pointerup` + `click`) so the native click can never re-enter the action. A
// short time-latch also drops a stray second `pointerdown` from the same tap.
//
// The element must NOT be a native form-submit on touch: pass `type="button"`
// (or omit type) so the swallowed click can't submit a form out from under us.
export function tapAction(coarse: () => boolean, action: (e: Event) => void) {
  let last = 0
  const swallow = (e: Event) => e.preventDefault()
  return {
    onClick: (e: MouseEvent) => {
      // On touch the action already ran on pointerdown; swallow this click.
      if (coarse()) {
        e.preventDefault()
        return
      }
      action(e)
    },
    onPointerDown: (e: PointerEvent) => {
      if (!coarse()) return
      const now = e.timeStamp || performance.now()
      if (now - last < 350) return
      last = now
      e.preventDefault()
      action(e)
    },
    onPointerUp: (e: PointerEvent) => {
      if (coarse()) swallow(e)
    },
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
