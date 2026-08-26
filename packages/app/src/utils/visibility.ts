import { createSignal } from "solid-js"

// One app-wide document-visibility source. Both the shared ticker (pause the
// 1Hz clock while hidden) and the global SSE loop (close the stream while
// hidden, rebuild on resume) read this, so there is a single definition of
// "hidden" for the whole app instead of one per consumer. It also owns the
// data-app-hidden attribute on <html> that CSS keys off to pause animations.
//
// Module-level and lazily armed: the first reader installs the listeners, and
// they live for the app's lifetime. Reading `hidden()` in a reactive scope
// tracks it.
//
// 🔴 `visibilitychange` ALONE CANNOT BE TRUSTED. In an iOS/iPadOS standalone
// PWA the page is frozen on app switch and the event is unreliable — most
// damagingly in the resume direction. A missed resume used to latch `hidden`
// true forever: the SSE loop stayed parked on whenVisible(), the 1Hz ticker
// never rearmed, and CSS animations stayed paused, all while the health poll
// (which is not visibility-gated) happily painted the connection green. Only a
// manual reload cleared it.
//
// So visibility is treated as a QUANTITY TO RE-DERIVE, never a transition to
// receive. Every signal that could accompany a resume — visibilitychange,
// pageshow, focus, the Page Lifecycle resume event, a Safari-only bfcache
// restore, and a slow poll as the floor — funnels into the same recompute.
// Redundant triggers are free (sync() exits early when nothing changed), and
// any ONE of them arriving is enough to recover. The poll guarantees recovery
// even when every event is dropped.

const [hidden, setHidden] = createSignal(read())
const waiters: Array<() => void> = []
const onlineWaiters: Array<() => void> = []

// Network transitions, bumped on every online/offline event. navigator.onLine is
// only a hint (MDN: a true value does not guarantee real connectivity), so the
// SSE loop treats a bump as "reconnect now" — an opportunistic fast path on top
// of the read-liveness watchdog, never the authority. A spurious online event
// just triggers one cheap clean reattach.
const [network, setNetwork] = createSignal(0)

// Bumped every time the page comes back from being hidden. Distinct from
// `hidden` going false, because a consumer that needs to re-verify state on
// resume must fire even when it never observed the hide.
const [resumed, setResumed] = createSignal(0)

function read() {
  return typeof document !== "undefined" && document.visibilityState === "hidden"
}

// The last state the app ACTED on, which is what a recompute must diff against.
// Reading the signal here instead would race Solid's update scheduling; the
// undefined case makes the first sync always apply, seeding the attribute.
let applied: boolean | undefined

function sync() {
  const next = read()
  if (next === applied) return
  applied = next
  document.documentElement.toggleAttribute("data-app-hidden", next)
  setHidden(next)
  if (next) return
  setResumed((n) => n + 1)
  for (const resolve of waiters.splice(0)) resolve()
}

// Poll interval when the page is visible. This is the floor that makes recovery
// unconditional: if every resume event is dropped, the page still notices
// within one tick. Cheap — reading visibilityState is a property access, and
// sync() returns immediately when nothing changed.
const POLL_MS = 2000

let armed = false
function arm() {
  if (armed || typeof document === "undefined") return
  armed = true

  document.addEventListener("visibilitychange", sync)
  // Fires on bfcache restore and on standalone-PWA resume, where
  // visibilitychange is the event most often missing.
  window.addEventListener("pageshow", sync)
  window.addEventListener("focus", sync)
  // Page Lifecycle. Chromium implements it; WebKit does not yet, which is why
  // it is one signal among several rather than the answer.
  document.addEventListener("resume", sync)
  document.addEventListener("freeze", sync)

  // The floor. A frozen page's timers do not run, so this tick is also a
  // reliable "we are executing again" signal on the first frame after thaw.
  setInterval(sync, POLL_MS)

  const bump = () => setNetwork((n) => n + 1)
  window.addEventListener("online", () => {
    bump()
    // A link returning is strong evidence the page is live again, and on iOS it
    // frequently arrives when no visibility event did.
    sync()
    onlineWaiters.splice(0).forEach((resolve) => resolve())
  })
  window.addEventListener("offline", bump)
  sync()
}

export const Visibility = {
  // Reactive: true while the tab is backgrounded. Tracks in a reactive scope.
  hidden() {
    arm()
    return hidden()
  },
  // Reactive: bumps every time the page returns to the foreground. Consumers
  // that must re-verify server state on resume watch this rather than the
  // hidden() edge, so a resume is actionable even if the hide was never seen.
  resumed() {
    arm()
    return resumed()
  },
  // Resolves the next time the tab is (or already is) visible. The SSE loop
  // awaits this before re-attaching so a hidden tab holds no open stream.
  whenVisible() {
    arm()
    if (!read()) return Promise.resolve()
    return new Promise<void>((resolve) => waiters.push(resolve))
  },
  // Reactive: bumps on every online/offline event. Tracks in a reactive scope;
  // the SSE loop watches it to reconnect the instant the network state changes.
  network() {
    arm()
    return network()
  },
  // Resolves the next time the browser reports a link (or already reports one).
  // Chunk loading races this: a retry issued while offline burns an attempt for
  // certain, so the loader waits here first. onLine is only a hint, so this is a
  // scheduling aid, never a guarantee the fetch will succeed.
  whenOnline() {
    arm()
    if (typeof navigator === "undefined" || navigator.onLine) return Promise.resolve()
    return new Promise<void>((resolve) => onlineWaiters.push(resolve))
  },
}
