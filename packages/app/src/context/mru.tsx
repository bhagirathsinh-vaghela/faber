import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { Persist, persisted } from "@/utils/persist"

const MRU_LIMIT = 100

// Per-client most-recently-viewed session order, global across projects and
// persisted to localStorage. MRU is a viewer notion (the order this client
// looked at sessions), so it lives on the client, never the server. The switcher
// dialog orders by this; the home overview ignores it. Stale IDs (archived or
// deleted sessions) are dropped where the order is consumed, against the live
// recent list.
export const { use: useMru, provider: MruProvider } = createSimpleContext({
  name: "Mru",
  init: () => {
    const [store, setStore] = persisted(
      Persist.global("mru.sessions.v1"),
      createStore<{ ids: string[] }>({ ids: [] }),
    )

    const touch = (id: string) =>
      setStore("ids", (ids) => [id, ...ids.filter((x) => x !== id)].slice(0, MRU_LIMIT))

    // Drop ids no longer in the live set (session archived or deleted). Called
    // when the overview renders, guarded by a non-empty live set so a transient
    // empty list mid-load can't wipe the whole MRU.
    const prune = (live: Set<string>) => {
      if (live.size === 0) return
      setStore("ids", (ids) => {
        const kept = ids.filter((id) => live.has(id))
        return kept.length === ids.length ? ids : kept
      })
    }

    return {
      touch,
      prune,
      order: () => store.ids,
    }
  },
})
