import { createMemo } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useGlobalSync } from "./global-sync"
import { useTicker } from "./ticker"
import { CACHE_TTL, beforeExpiryMs, cacheCountdownUntil } from "@/utils/cache-countdown"

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
    const { now } = useTicker()

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
    // section. Membership uses globalSync.needsAttention — the same predicate
    // transcript eviction protects on — so the overview's attention list and the
    // never-evict set stay one definition. It rides only server-pushed fields
    // (busy/unseen/pingAt), never the local clock, so the buckets recompute on
    // server updates rather than every tick — the ping deadline is cleared
    // server-side when its window lapses.
    const attention = createMemo(() =>
      rows()
        .filter((r) => globalSync.needsAttention(r))
        .sort((a, b) => b.updated - a.updated),
    )
    const recent = createMemo(() =>
      rows()
        .filter((r) => !globalSync.needsAttention(r))
        .sort((a, b) => b.updated - a.updated),
    )

    // Always resolve the LIVE row by id, never trust a passed-in snapshot. The
    // overview freezes row ORDER via a keyed <For>, which hands the render
    // callback a by-reference-stale row object between reconciles. Reading pingAt
    // off that snapshot lets the countdown tick toward an outdated deadline after
    // the server re-arms a ping. Re-deriving from rows() here keeps the ping
    // deadline live per tick while the order stays frozen. Falls back to the
    // passed row if the session already left the hub.
    const live = (row: OverviewRow) => rows().find((r) => r.sessionID === row.sessionID) ?? row

    const countdown = (row: OverviewRow) => cacheCountdownUntil(live(row).pingAt, now())

    // The ring next to the countdown, from the SAME anchor (pingAt) and the SAME
    // shared clock as countdown() above, re-derived from the live row so it can't
    // lag the text. The window is expiry minus beforeExpiry (the anchor-to-ping
    // span), matching the statusline ring, so the ring reads full at max and
    // empties exactly when the countdown hits 00:00.
    const remaining = (row: OverviewRow) => {
      const at = live(row).pingAt
      if (!at) return 0
      const window = CACHE_TTL - beforeExpiryMs(globalSync.data.config)
      return Math.max(0, Math.min(1, (at - now()) / window))
    }

    return { attention, recent, countdown, remaining }
  },
})
