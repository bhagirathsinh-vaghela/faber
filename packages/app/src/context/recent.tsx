import { createMemo, createSignal, onCleanup } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useGlobalSync } from "./global-sync"
import { cacheCountdownFrom } from "@/utils/cache-countdown"

export type OverviewRow = {
  sessionID: string
  directory: string
  title: string
  updated: number
  busy: boolean
  unseen: boolean
  countdown: string | null
}

export const { use: useRecent, provider: RecentProvider } = createSimpleContext({
  name: "Recent",
  init: () => {
    const globalSync = useGlobalSync()

    const [now, setNow] = createSignal(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))

    // Membership, title, and base recency come from the server-owned recent hub
    // so every client renders the same overview. Live busy/countdown are layered
    // on top: countdown from the global armed hub (correct after a reload), busy
    // from the directory child store only when it is already open (bootstrap:
    // false) — a not-open session simply reads not-busy.
    const rows = createMemo<OverviewRow[]>(() =>
      globalSync.data.recent_hub.map((entry) => {
        const [child] = globalSync.child(entry.directory, { bootstrap: false })
        const status = child.session_status[entry.sessionID]
        const busy = status?.type === "busy" || status?.type === "retry"
        const unseen = child.session.find((s) => s.id === entry.sessionID)?.unseen === true
        const armed = globalSync.data.armed_hub[entry.sessionID]
        const countdown = armed ? cacheCountdownFrom(armed.lastRequestAt, armed.beforeExpiry, now()) : null
        return {
          sessionID: entry.sessionID,
          directory: entry.directory,
          title: entry.title,
          updated: entry.updated,
          busy,
          unseen,
          countdown,
        }
      }),
    )

    // A session is in exactly one bucket. Both sort by last real-turn activity
    // (never pings/views) — recent newest-first ("what I just did"), attention
    // oldest-first so the most-neglected sits on top ("what I've been ignoring").
    // The countdown gates attention membership but not order: it's display-only.
    const attention = createMemo(() =>
      rows()
        .filter((r) => r.busy || r.unseen || r.countdown)
        .sort((a, b) => a.updated - b.updated),
    )
    const recent = createMemo(() =>
      rows()
        .filter((r) => !(r.busy || r.unseen || r.countdown))
        .sort((a, b) => b.updated - a.updated),
    )

    return { attention, recent }
  },
})
