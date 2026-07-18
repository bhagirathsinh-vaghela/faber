import { createSignal, onCleanup } from "solid-js"

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
