import { createEffect, createMemo, createRoot, createSignal } from "solid-js"

// The app's ONE size decision. Everything that used to ask the viewport
// directly — five JS call sites and four hand-written media queries at four
// different thresholds — reads this instead.
//
// It publishes to `data-size-class` on <html>, and the Tailwind `compact:` /
// `wide:` / `expanded:` variants select on that attribute rather than running
// their own @media. So CSS and JS cannot hold different opinions: there is one
// value, and both read it. A forced class is therefore honoured everywhere for
// free, including in stylesheets that never learn it exists.
//
// Scope: shell TOPOLOGY only (how many panes, sidebar docked or overlaid).
// Anything sized by its own box asks a container query instead, and anything
// about the device (touch, hover, safe areas) asks a capability query.

export type SizeClass = "compact" | "medium" | "expanded"

const STORAGE_KEY = "opencode-size-class"

// Material 3 window size classes, in CSS px. Width and height are classified
// separately: 600 splits phone from tablet, 840 splits tablet from desktop. A
// wide-but-short window (landscape phone, dragged-flat desktop window) has the
// width for a third pane and nowhere to put its contents, so height demotes it.
const QUERIES = {
  medium: "(min-width: 600px)",
  expanded: "(min-width: 840px) and (min-height: 480px)",
} as const

function stored(): SizeClass | undefined {
  const value = localStorage.getItem(STORAGE_KEY)
  if (value === "compact" || value === "medium" || value === "expanded") return value
  return undefined
}

const shell = createRoot(() => {
  // matchMedia, not a resize listener: the browser evaluates these natively and
  // notifies only when a threshold is actually crossed. A resize listener would
  // instead fire every frame of a window drag and read innerWidth each time,
  // forcing layout on the main thread hundreds of times to learn nothing.
  const medium = window.matchMedia(QUERIES.medium)
  const expanded = window.matchMedia(QUERIES.expanded)

  const measure = (): SizeClass => (expanded.matches ? "expanded" : medium.matches ? "medium" : "compact")

  const [natural, setNatural] = createSignal(measure())
  const [forced, setForced] = createSignal(stored())

  const sync = () => setNatural(measure())
  medium.addEventListener("change", sync, { passive: true })
  expanded.addEventListener("change", sync, { passive: true })

  const active = createMemo(() => forced() ?? natural())

  createEffect(() => {
    document.documentElement.dataset.sizeClass = active()
  })

  function force(next: SizeClass | undefined) {
    setForced(next)
    if (!next) {
      localStorage.removeItem(STORAGE_KEY)
      return
    }
    localStorage.setItem(STORAGE_KEY, next)
  }

  return {
    sizeClass: active,
    natural,
    forced,
    compact: createMemo(() => active() === "compact"),
    // "Is there room for more than one pane" — the question most call sites are
    // actually asking, and the one the old `isDesktop` boolean stood in for.
    wide: createMemo(() => active() !== "compact"),
    expanded: createMemo(() => active() === "expanded"),
    force,
    // Cycling between the two ends is the whole gesture; landing back on what
    // the window would have chosen releases the pin so it tracks again.
    toggle() {
      const next: SizeClass = active() === "compact" ? "expanded" : "compact"
      force(next === natural() ? undefined : next)
    },
  }
})

export function useShell() {
  return shell
}
