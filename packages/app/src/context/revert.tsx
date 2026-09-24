import { createSimpleContext } from "@opencode-ai/ui/context"
import type { RevertMessageFn } from "@opencode-ai/ui/context"
import { onCleanup } from "solid-js"

// The transcript's "Revert here" button is wired by the directory layout, but
// the prompt box and stash it has to update live on the session page, below
// it. The page registers the one revert implementation here and the layout
// forwards the button to it, so the card and the undo command cannot drift.
export const { use: useRevertHost, provider: RevertHostProvider } = createSimpleContext({
  name: "RevertHost",
  init: () => {
    let handler: RevertMessageFn | undefined
    return {
      register(fn: RevertMessageFn) {
        handler = fn
        onCleanup(() => {
          if (handler === fn) handler = undefined
        })
      },
      revert: ((input) => handler?.(input)) as RevertMessageFn,
    }
  },
})
