import { createMemo, createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { QuestionRequest } from "@opencode-ai/sdk/v2"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { useLocal } from "./local"
import { Identifier } from "@/utils/id"
import { useParams } from "@solidjs/router"

// Shared question state across the pinned panel and the prompt action bar.
// Mirrors the TUI's routes/session/index.tsx: a deferred question is removed
// from sync server-side but kept in a local list so question_list (alt+y) can
// re-surface it, and the visible set is pending ∪ deferred. Lives in context so
// the action bar's "questions N" count reflects deferred ones the panel holds.
export const { use: useQuestion, provider: QuestionProvider } = createSimpleContext({
  name: "Question",
  init: () => {
    const sdk = useSDK()
    const sync = useSync()
    const local = useLocal()
    const params = useParams()

    const pending = createMemo(() => (params.id ? (sync.data.question[params.id] ?? []) : []))
    const [deferred, setDeferred] = createStore<QuestionRequest[]>([])
    const [visible, setVisible] = createSignal(false)

    const pendingIDs = createMemo(() => new Set(pending().map((q) => q.id)))
    const requests = createMemo(() => {
      const ids = pendingIDs()
      return [...pending(), ...deferred.filter((q) => !ids.has(q.id))]
    })

    function drop(id: string) {
      setDeferred((prev) => prev.filter((q) => q.id !== id))
    }

    function hide(reqs: QuestionRequest[]) {
      setDeferred(
        produce((draft) => {
          const ids = new Set(draft.map((q) => q.id))
          for (const r of reqs) if (!ids.has(r.id)) draft.push(r)
        }),
      )
      setVisible(false)
    }

    function answered(id: string, answers: string[][], qs: QuestionRequest["questions"]) {
      drop(id)
      if (pendingIDs().has(id)) return
      // The original request expired server-side, so reply() would no-op. Send
      // the answer as a fresh prompt instead, matching the TUI's deferred path.
      const formatted = qs
        .map((q, i) => `"${q.question}" = "${answers[i]?.join(", ") || "Unanswered"}"`)
        .join("\n")
      const model = local.model.current()
      sdk.client.session
        .prompt({
          sessionID: params.id!,
          agent: local.agent.current()?.name,
          model: model ? { modelID: model.id, providerID: model.provider.id } : undefined,
          variant: local.model.variant.current(),
          messageID: Identifier.ascending("message"),
          parts: [
            {
              id: Identifier.ascending("part"),
              type: "text",
              text: `Answering your earlier deferred question:\n${formatted}`,
            },
          ],
        })
        .catch(() => {})
    }

    return {
      pending,
      pendingIDs,
      requests,
      get count() {
        return requests().length
      },
      visible,
      show: () => setVisible(true),
      toggle: () => setVisible((v) => !v),
      hide,
      drop,
      answered,
    }
  },
})
