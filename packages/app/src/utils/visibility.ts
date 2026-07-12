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

function read() {
  return typeof document !== "undefined" && document.visibilityState === "hidden"
}

function sync() {
  const next = read()
  document.documentElement.toggleAttribute("data-app-hidden", next)
  setHidden(next)
  if (next) return
  const pending = waiters.splice(0)
  for (const resolve of pending) resolve()
}

let armed = false
function arm() {
  if (armed || typeof document === "undefined") return
  armed = true
  document.addEventListener("visibilitychange", sync)
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
}
