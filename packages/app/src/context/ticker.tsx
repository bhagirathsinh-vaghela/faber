import { createSignal, onCleanup, onMount } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"

// One app-global 1Hz clock, shared by every live countdown (statusline cache
// ring, overview ping deadlines, working-turn elapsed). Before
// this, each site ran its own setInterval seeded at its own mount time, so two
// views of the same deadline could read `now` up to a second apart and show
// different values — the session view and the overview visibly disagreed. One
// interval means one `now`, so every consumer ticks in lockstep.
//
// It is also the visibility gate for the whole UI: while the tab is hidden the
// interval is cleared (no wakeups, no battery burn) and `data-app-hidden` is set
// on <html> so CSS can pause infinite animations. On becoming visible we snap
// `now` to the real clock immediately (so the face is correct before the next
// tick) and rearm the interval.
export const { use: useTicker, provider: TickerProvider } = createSimpleContext({
  name: "Ticker",
  init: () => {
    const [now, setNow] = createSignal(Date.now())

    onMount(() => {
      let timer: ReturnType<typeof setInterval> | undefined

      const start = () => {
        if (timer) return
        timer = setInterval(() => setNow(Date.now()), 1000)
      }
      const stop = () => {
        if (!timer) return
        clearInterval(timer)
        timer = undefined
      }

      const sync = () => {
        const hidden = document.visibilityState === "hidden"
        document.documentElement.toggleAttribute("data-app-hidden", hidden)
        if (hidden) {
          stop()
          return
        }
        setNow(Date.now())
        start()
      }

      document.addEventListener("visibilitychange", sync)
      sync()

      onCleanup(() => {
        document.removeEventListener("visibilitychange", sync)
        document.documentElement.removeAttribute("data-app-hidden")
        stop()
      })
    })

    return { now }
  },
})
