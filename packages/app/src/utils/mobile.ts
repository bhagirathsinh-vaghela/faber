import { createSignal, onCleanup } from "solid-js"

// Reactive "is this a touch-primary device" signal. Matches the app's existing
// mobile idiom (ui/src/styles/base.css, app/src/index.css): coarse pointer with
// no hover targets phones/tablets, not touchscreen laptops that still drive a
// trackpad. Used to gate soft-keyboard suppression — the question this answers
// is "will focusing an input raise the OS keyboard", which UA sniffing gets
// wrong (iPad reports as desktop Safari).
export function createCoarsePointer() {
  const query = window.matchMedia("(hover: none) and (pointer: coarse)")
  const [coarse, setCoarse] = createSignal(query.matches)
  const handler = () => setCoarse(query.matches)
  query.addEventListener("change", handler)
  onCleanup(() => query.removeEventListener("change", handler))
  return coarse
}
