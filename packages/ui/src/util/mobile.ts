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
