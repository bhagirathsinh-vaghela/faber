import { createSignal, onCleanup, onMount } from "solid-js"

// Whether a floating HUD is on screen and owns the keyboard. Every overlay
// claims this through OverlayPanel, so precedence is stated once rather than
// re-derived per feature, and a handler yields to "an overlay" rather than to a
// list of them that has to be kept current.
//
// A count, not a boolean: two overlays can overlap (a reading started while a
// dictation settles), and the second one closing must not hand the keyboard
// back while the first is still up.
//
// The claim OUTLIVES capture. A dictation HUD stays up while a batch engine
// transcribes, owning Enter, Escape and Space for that whole time, so this is
// tied to the panel being mounted rather than to any capture being live.
const [claims, setClaims] = createSignal(0)

export const overlayActive = () => claims() > 0

// Held for the lifetime of the calling component. Capture-phase handlers fire
// in mount order rather than by what is in front of the user, which is why
// precedence has to be declared rather than inferred from the event.
export function claimOverlay() {
  onMount(() => setClaims((n) => n + 1))
  onCleanup(() => setClaims((n) => n - 1))
}
