import { createMemo, createSignal, onCleanup } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { useGlobalSync } from "./global-sync"
import { cacheCountdown, beforeExpiryMs } from "@/utils/cache-countdown"

export type OverviewRow = {
  session: Session
  directory: string
  busy: boolean
  unseen: boolean
  countdown: string | null
}

export type OverviewProject = {
  directory: string
  rows: OverviewRow[]
}

export const { use: useOverview, provider: OverviewProvider } = createSimpleContext({
  name: "Overview",
  init: () => {
    const globalSync = useGlobalSync()

    const [now, setNow] = createSignal(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))

    // One row per attention-worthy session, grouped by project. A session is
    // attention-worthy if it is busy, has an unseen result, or has a live ping
    // countdown. busy comes from session_status, unseen from the server-owned
    // session.unseen field. The countdown is gated on ping_armed — the daemon's
    // live in-instance state — so a stale persisted cache anchor from a prior
    // process never lights will-ping. A live countdown implies armed, so the
    // listing predicate collapses to busy || unseen || countdown.
    const projects = createMemo<OverviewProject[]>(() => {
      const expiry = beforeExpiryMs(globalSync.data.config)
      const result: OverviewProject[] = []
      for (const project of globalSync.data.project) {
        const [store] = globalSync.child(project.worktree)
        const rows: OverviewRow[] = []
        for (const session of store.session) {
          if (session.parentID) continue
          if (session.time?.archived) continue
          const status = store.session_status[session.id]
          const busy = status?.type === "busy" || status?.type === "retry"
          const unseen = session.unseen === true
          const armed = store.ping_armed[session.id] === true
          const countdown = armed ? cacheCountdown(session, expiry, now()) : null
          if (!busy && !unseen && !countdown) continue
          rows.push({ session, directory: project.worktree, busy, unseen, countdown })
        }
        if (rows.length) result.push({ directory: project.worktree, rows })
      }
      return result
    })

    const any = createMemo(() => projects().length > 0)

    return { projects, any }
  },
})
