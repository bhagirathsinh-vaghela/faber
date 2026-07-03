import { createMemo, createSignal, onCleanup } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useGlobalSync } from "./global-sync"
import { cacheCountdownUntil } from "@/utils/cache-countdown"

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

    // The whole overview is the server-owned recent hub — membership, recency,
    // and the live flags (busy, unseen, next-ping deadline) all ride the same
    // projection, so every client renders identically without opening any
    // directory. The only client-local work is ticking the ping deadline into a
    // mm:ss string against the local clock.
    const rows = createMemo<OverviewRow[]>(() =>
      globalSync.data.recent_hub.map((entry) => ({
        sessionID: entry.sessionID,
        directory: entry.directory,
        title: entry.title,
        updated: entry.updated,
        busy: entry.busy,
        unseen: entry.unseen,
        countdown: cacheCountdownUntil(entry.pingAt, now()),
      })),
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
