import { createEffect, createSignal, onCleanup } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { Visibility } from "@/utils/visibility"

// One app-global 1Hz clock, shared by every live countdown (statusline cache
// ring, overview ping deadlines, working-turn elapsed). Before
// this, each site ran its own setInterval seeded at its own mount time, so two
// views of the same deadline could read `now` up to a second apart and show
// different values — the session view and the overview visibly disagreed. One
// interval means one `now`, so every consumer ticks in lockstep.
//
// While the tab is hidden the interval is cleared (no wakeups, no battery
// burn); the shared Visibility source owns the listener and the data-app-hidden
// attribute. On becoming visible we snap `now` to the real clock immediately
// (so the face is correct before the next tick) and rearm.
export const { use: useTicker, provider: TickerProvider } = createSimpleContext({
  name: "Ticker",
  init: () => {
    const [now, setNow] = createSignal(Date.now())

    createEffect(() => {
      if (Visibility.hidden()) return
      setNow(Date.now())
      const timer = setInterval(() => setNow(Date.now()), 1000)
      onCleanup(() => clearInterval(timer))
    })

    return { now }
  },
})
