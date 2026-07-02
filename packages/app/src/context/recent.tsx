import { createMemo } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { persisted } from "@/utils/persist"
import { useGlobalSync } from "./global-sync"
import { cacheCountdownFrom } from "@/utils/cache-countdown"
import { createSignal, onCleanup } from "solid-js"

// Sessions the user has touched in THIS web UI. Persisted (survives reload and
// server crash), web-UI-only (the server/TUI can never add here — entries are
// written client-side on prompt-send and session-open). Recency is the
// session's transcript timestamp, refreshed from live data when the session is
// loaded. Capped at the 50 most-recent.
const LIMIT = 50

type Entry = {
  directory: string
  title: string
  updated: number
}

type Store = {
  entries: Record<string, Entry>
}

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
    const [store, setStore] = persisted("recent.v1", createStore<Store>({ entries: {} }))

    const [now, setNow] = createSignal(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))

    function upsert(session: Pick<Session, "id" | "directory" | "title" | "time" | "parentID">) {
      if (!session.id || !session.directory) return
      if (session.parentID) return
      const updated = session.time?.updated ?? session.time?.created ?? Date.now()
      setStore(
        produce((draft) => {
          draft.entries[session.id] = {
            directory: session.directory!,
            title: session.title ?? "",
            updated,
          }
          const ids = Object.keys(draft.entries)
          if (ids.length > LIMIT) {
            const drop = ids.sort((a, b) => draft.entries[b].updated - draft.entries[a].updated).slice(LIMIT)
            for (const id of drop) delete draft.entries[id]
          }
        }),
      )
    }

    function remove(sessionID: string) {
      setStore(
        "entries",
        produce((entries) => delete entries[sessionID]),
      )
    }

    // Read live signals for a session WITHOUT bootstrapping its directory. The
    // armed state + countdown come from the global armed hub (session-keyed,
    // fetched once), so the overview stays correct after a reload. busy/unseen
    // and the live timestamp come from the directory child store only when it is
    // already open (bootstrap:false); for a not-open session they simply read
    // false, which is fine — the overview cares about armed/countdown.
    function signals(directory: string, sessionID: string) {
      const [child] = globalSync.child(directory, { bootstrap: false })
      const status = child.session_status[sessionID]
      const session = child.session.find((s) => s.id === sessionID)
      const busy = status?.type === "busy" || status?.type === "retry"
      const unseen = session?.unseen === true
      const armed = globalSync.data.armed_hub[sessionID]
      const countdown = armed ? cacheCountdownFrom(armed.lastRequestAt, armed.beforeExpiry, now()) : null
      // Prefer the live transcript timestamp when the session is loaded.
      const updated = session?.time?.updated ?? session?.time?.created
      return { busy, unseen, countdown, updated }
    }

    const rows = createMemo<OverviewRow[]>(() =>
      Object.entries(store.entries).map(([sessionID, entry]) => {
        const live = signals(entry.directory, sessionID)
        return {
          sessionID,
          directory: entry.directory,
          title: entry.title,
          updated: live.updated ?? entry.updated,
          busy: live.busy,
          unseen: live.unseen,
          countdown: live.countdown,
        }
      }),
    )

    // Active: needs attention now (this process). Recent: everything else,
    // newest first. A session is in exactly one bucket.
    const attention = createMemo(() => rows().filter((r) => r.busy || r.unseen || r.countdown))
    const recent = createMemo(() =>
      rows()
        .filter((r) => !(r.busy || r.unseen || r.countdown))
        .sort((a, b) => b.updated - a.updated),
    )

    return { upsert, remove, attention, recent }
  },
})
