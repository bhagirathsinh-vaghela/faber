import { createMemo, createSignal } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useSync } from "./sync"
import { useParams } from "@solidjs/router"

// Shared question state across the pinned panel and the prompt action bar.
// A pending question blocks server-side but the ping daemon keeps the cache
// warm, so blocking is harmless — the web panel is collapsible instead of
// deferrable. `collapsed` shrinks the floating panel to a one-line bar near
// the dock without touching the server; the question stays live and pending.
// (Defer still exists server-side for the TUI, which cannot collapse.)
export const { use: useQuestion, provider: QuestionProvider } = createSimpleContext({
  name: "Question",
  init: () => {
    const sync = useSync()
    const params = useParams()

    const pending = createMemo(() => (params.id ? (sync.data.question[params.id] ?? []) : []))
    const [collapsed, setCollapsed] = createSignal(false)

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
    }
  },
})
