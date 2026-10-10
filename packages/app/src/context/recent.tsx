import { createMemo } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useGlobalSync } from "./global-sync"
import { useTicker } from "./ticker"
import { beforeExpiryMs, pingCountdown } from "@/utils/cache-countdown"

export type OverviewRow = {
  sessionID: string
  directory: string
  title: string
  // The agent that ran the last turn; tints the busy dot's own-busy state
  // (agentColor), matching every other busy indicator. Absent for rows the
  // server touched before it carried an agent.
  agent?: string
  updated: number
  // Live busy facts, read from the one operative store (session_busy), NOT the
  // recent_hub row's own copy — so the dot animates off the same state the
  // session view does and can never lag it.
  turn: boolean
  subagents: number
  jobs: number
  unseen: boolean
  question: boolean
  permission: boolean
  error: boolean
  pingAt?: number
  // Last successful ping's dispatch time. Recent sessions order on
  // `interacted`, which folds this together with `updated`.
  pinged?: number
  // Last interaction of any kind: a real turn or a cache ping. Both are the
  // session doing work on the user's behalf; neither an open nor a stop counts.
  interacted: number
  starred: boolean
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
    //
    // Rebuilding row objects each frame is not an option: <For> keys on object
    // identity, so fresh rows remount the entire list's DOM per hub frame.
    const wrappers = new Map<string, OverviewRow>()
    const rows = createMemo<OverviewRow[]>(() => {
      const next = globalSync.data.recent_hub.map((entry) => {
        const cached = wrappers.get(entry.sessionID)
        if (cached) return cached
        const row: OverviewRow = {
          sessionID: entry.sessionID,
          directory: entry.directory,
          get title() {
            return entry.title
          },
          get agent() {
            return entry.agent
          },
          get updated() {
            return entry.updated
          },
          get turn() {
            return globalSync.busy(entry.directory, entry.sessionID).turn
          },
          get subagents() {
            return globalSync.busy(entry.directory, entry.sessionID).subagents
          },
          get jobs() {
            return globalSync.busy(entry.directory, entry.sessionID).jobs
          },
          get unseen() {
            return entry.unseen
          },
          // A server that predates these flags omits them; absent reads as off.
          get question() {
            return entry.question ?? false
          },
          get permission() {
            return entry.permission ?? false
          },
          get error() {
            return entry.error ?? false
          },
          get pingAt() {
            return entry.pingAt
          },
          get pinged() {
            return entry.pinged
          },
          get interacted() {
            return Math.max(entry.updated, entry.pinged ?? 0)
          },
          get starred() {
            return entry.starred ?? false
          },
        }
        wrappers.set(entry.sessionID, row)
        return row
      })
      // Reconcile detaches the store node a departed id's wrapper reads through,
      // so a session re-entering the hub must get a new wrapper on a live node.
      if (wrappers.size > next.length) {
        const keep = new Set(next.map((row) => row.sessionID))
        for (const id of wrappers.keys()) if (!keep.has(id)) wrappers.delete(id)
      }
      return next
    })

    // A session is in exactly one bucket, newest-first within each. Membership
    // uses globalSync.isAlive — the same predicate transcript eviction protects
    // on — so the overview's live list and the never-evict set stay one
    // definition. It rides only server-pushed fields (busy/pingAt), never the
    // local clock, so the buckets recompute on server updates rather than every
    // tick — the ping deadline is cleared server-side when its window lapses. An
    // unseen-but-idle session sorts into recent and keeps its dot.
    //
    // The two sections order on different clocks on purpose. Live sessions sorts
    // on last real turn, so a list of working sessions can't reshuffle on ping
    // timing (every armed session re-anchors on its own cache schedule). Recent
    // sessions sorts on last interaction of ANY kind, because a session kept
    // warm for an hour was in use that whole time even though its pings persist
    // no message — ordering it on the stale turn timestamp buries it under
    // sessions abandoned earlier. Neither clock counts an open or a stop: those
    // are per-device acts; the client MRU layers view order onto the live
    // section only.
    const attention = createMemo(() =>
      rows()
        .filter((r) => globalSync.isAlive(r))
        .sort((a, b) => b.updated - a.updated),
    )
    const recent = createMemo(() =>
      rows()
        .filter((r) => !globalSync.isAlive(r))
        .sort((a, b) => b.interacted - a.interacted),
    )

    // Always resolve the LIVE row by id, never trust a passed-in snapshot. The
    // overview freezes row ORDER via a keyed <For>, which hands the render
    // callback a by-reference-stale row object between reconciles. Reading pingAt
    // off that snapshot lets the countdown tick toward an outdated deadline after
    // the server re-arms a ping. Re-deriving from rows() here keeps the ping
    // deadline live per tick while the order stays frozen. Falls back to the
    // passed row if the session already left the hub.
    //
    // Indexed rather than scanned: every row resolves through here on each 1Hz
    // tick, so a linear lookup would make the overview quadratic in row count.
    const index = createMemo(() => new Map(rows().map((row) => [row.sessionID, row])))
    const live = (row: OverviewRow) => index().get(row.sessionID) ?? row

    // countdown text and ring fraction both come from the shared predicate
    // (pingCountdown) the session statusline also uses, fed the live row's
    // pingAt. before_expiry comes from the global config here but from the
    // session directory's config in the statusline, so a project-level
    // ping.before_expiry makes the two rings differ; the text agrees.
    // Re-derive off the live row each tick so neither lags a re-armed ping.
    const countdown = (row: OverviewRow) =>
      pingCountdown(live(row).pingAt, beforeExpiryMs(globalSync.data.config), now()).text

    const remaining = (row: OverviewRow) =>
      pingCountdown(live(row).pingAt, beforeExpiryMs(globalSync.data.config), now()).fraction

    return { attention, recent, countdown, remaining, get: (id: string) => index().get(id) }
  },
})
