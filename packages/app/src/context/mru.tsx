import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { Persist, persisted } from "@/utils/persist"

const MRU_LIMIT = 100

// Per-client most-recently-viewed session order, global across projects and
// persisted to localStorage. MRU is a viewer notion (the order this client
// looked at sessions), so it lives on the client, never the server. The switcher
// dialog orders by this; the home overview ignores it. Never pruned against any
// one switcher's list: the root switcher and the subagent switcher each read
// their own ids out of this shared order, so a stale id is simply unmatched and
// ages out under the cap.
export const { use: useMru, provider: MruProvider } = createSimpleContext({
  name: "Mru",
  init: () => {
    const [store, setStore] = persisted(Persist.global("mru.sessions.v1"), createStore<{ ids: string[] }>({ ids: [] }))

    const touch = (id: string) => setStore("ids", (ids) => [id, ...ids.filter((x) => x !== id)].slice(0, MRU_LIMIT))

    return {
      touch,
      order: () => store.ids,
    }
  },
})
