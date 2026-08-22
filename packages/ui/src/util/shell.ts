import { createEffect, createMemo, createRoot, createSignal } from "solid-js"
import { measureSizeClass, parseSizeClass, SIZE_CLASS_KEY, SIZE_QUERIES, type SizeClass } from "./size-class"

export type { SizeClass }

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
// The key, thresholds, and classification live in ./size-class, shared with
// the app's pre-paint script so the two cannot drift.
//
// Scope: shell TOPOLOGY only (how many panes, sidebar docked or overlaid).
// Anything sized by its own box asks a container query instead, and anything
// about the device (touch, hover, safe areas) asks a capability query.

const shell = createRoot(() => {
  // matchMedia, not a resize listener: the browser evaluates these natively and
  // notifies only when a threshold is actually crossed. A resize listener would
  // instead fire every frame of a window drag and read innerWidth each time,
  // forcing layout on the main thread hundreds of times to learn nothing.
  const medium = window.matchMedia(SIZE_QUERIES.medium)
  const expanded = window.matchMedia(SIZE_QUERIES.expanded)

  const measure = () => measureSizeClass({ medium: medium.matches, expanded: expanded.matches })

  const [natural, setNatural] = createSignal(measure())
  const [forced, setForced] = createSignal(parseSizeClass(sessionStorage.getItem(SIZE_CLASS_KEY)))

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
      sessionStorage.removeItem(SIZE_CLASS_KEY)
      return
    }
    sessionStorage.setItem(SIZE_CLASS_KEY, next)
  }

  // Both ends must be reachable from every natural class: a medium tablet is
  // entitled to the desktop layout just as much as to the phone one, so a
  // stop is skipped only when it restates what the window already shows.
  function cycle(): SizeClass | undefined {
    const current = forced()
    if (!current) return natural() === "compact" ? "expanded" : "compact"
    if (current === "compact") return natural() === "expanded" ? undefined : "expanded"
    return undefined
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
    // Where the next toggle() lands (undefined = back to the window's answer),
    // so the control announcing the destination cannot disagree with the press.
    next: createMemo(() => cycle()),
    toggle() {
      force(cycle())
    },
  }
})

export function useShell() {
  return shell
}
