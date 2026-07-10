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
  pingAt?: number
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
    // directory. The rows carry the raw ping deadline; the mm:ss string is ticked
    // per row via countdown() so the clock never churns the list arrays.
    const rows = createMemo<OverviewRow[]>(() =>
      globalSync.data.recent_hub.map((entry) => ({
        sessionID: entry.sessionID,
        directory: entry.directory,
        title: entry.title,
        updated: entry.updated,
        busy: entry.busy,
        unseen: entry.unseen,
        pingAt: entry.pingAt,
      })),
    )

    // A session is in exactly one bucket. Both sort by last real-turn activity
    // (never pings/views), newest-first — most-recently-active on top in either
    // section. Membership uses globalSync.attentionSession — the same predicate
    // transcript eviction protects on — so the overview's attention list and the
    // never-evict set stay one definition. It rides only server-pushed fields
    // (busy/unseen/pingAt), never the local clock, so the buckets recompute on
    // server updates rather than every tick — the ping deadline is cleared
    // server-side when its window lapses.
    const attention = createMemo(() =>
      rows()
        .filter((r) => globalSync.attentionSession(r))
        .sort((a, b) => b.updated - a.updated),
    )
    const recent = createMemo(() =>
      rows()
        .filter((r) => !globalSync.attentionSession(r))
        .sort((a, b) => b.updated - a.updated),
    )

    const countdown = (row: OverviewRow) => cacheCountdownUntil(row.pingAt, now())

    return { attention, recent, countdown }
  },
})
