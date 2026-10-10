import { createEffect, createMemo, createSignal } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useSync } from "./sync"
import { useParams } from "@solidjs/router"

// Shared question state across the pinned panel and the prompt action bar.
// A pending question blocks server-side but the ping daemon keeps the cache
// warm, so blocking is harmless — the web panel is collapsible instead of
// deferrable. `collapsed` shrinks the floating panel to a one-line bar near
// the dock without touching the server; the question stays live and pending.
export const { use: useQuestion, provider: QuestionProvider } = createSimpleContext({
  name: "Question",
  init: () => {
    const sync = useSync()
    const params = useParams()

    // Requests answered locally but not yet confirmed removed by the server.
    // The panel dismisses on the press instead of holding for the reply
    // round-trip plus the SSE removal — on a remote client that wait reads as
    // the button not working. A failed reply unmarks, which re-shows the
    // request.
    const [answered, setAnswered] = createSignal<Set<string>>(new Set(), { equals: false })

    const serverPending = createMemo(() => (params.id ? (sync.data.question[params.id] ?? []) : []))
    const pending = createMemo(() => serverPending().filter((q) => !answered().has(q.id)))
    const [collapsed, setCollapsed] = createSignal(false)

    // Confirmed removals need no local override, and a request the server no
    // longer lists must not leak its id into a future request's lifetime.
    createEffect(() => {
      const live = new Set(serverPending().map((q) => q.id))
      const current = answered()
      if (![...current].some((id) => !live.has(id))) return
      setAnswered((prev) => {
        const next = new Set([...prev].filter((id) => live.has(id)))
        return next
      })
    })

    const pendingIDs = createMemo(() => new Set(pending().map((q) => q.id)))

    // Total questions across all pending requests — a single request can bundle
    // multiple (tabbed) questions, so the footer count reflects how many things
    // the user is being asked, not how many blocking asks are open.
    const total = createMemo(() => pending().reduce((n, r) => n + r.questions.length, 0))

    return {
      pending,
      pendingIDs,
      requests: pending,
      get count() {
        return pending().length
      },
      total,
      collapsed,
      collapse: () => setCollapsed(true),
      expand: () => setCollapsed(false),
      markAnswered(id: string) {
        setAnswered((prev) => new Set(prev).add(id))
      },
      unmarkAnswered(id: string) {
        setAnswered((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      },
    }
  },
})
