import { createSignal } from "solid-js"

// One app-wide document-visibility source. Both the shared ticker (pause the
// 1Hz clock while hidden) and the global SSE loop (close the stream while
// hidden, rebuild on resume) read this, so there is a single visibilitychange
// listener and a single definition of "hidden" for the whole app instead of one
// per consumer. It also owns the data-app-hidden attribute on <html> that CSS
// keys off to pause animations.
//
// Module-level and lazily armed: the first reader installs the listener, and it
// lives for the app's lifetime (there is no point tearing a document listener
// down and back up). Reading `hidden()` in a reactive scope tracks it.

const [hidden, setHidden] = createSignal(read())
const waiters: Array<() => void> = []
const onlineWaiters: Array<() => void> = []

// Network transitions, bumped on every online/offline event. navigator.onLine is
// only a hint (MDN: a true value does not guarantee real connectivity), so the
// SSE loop treats a bump as "reconnect now" — an opportunistic fast path on top
// of the read-liveness watchdog, never the authority. A spurious online event
// just triggers one cheap clean reattach.
const [network, setNetwork] = createSignal(0)

function read() {
  return typeof document !== "undefined" && document.visibilityState === "hidden"
}

function sync() {
  const next = read()
  document.documentElement.toggleAttribute("data-app-hidden", next)
  setHidden(next)
  if (next) return
  for (const resolve of waiters.splice(0)) resolve()
}

let armed = false
function arm() {
  if (armed || typeof document === "undefined") return
  armed = true
  document.addEventListener("visibilitychange", sync)
  const bump = () => setNetwork((n) => n + 1)
  window.addEventListener("online", () => {
    bump()
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
