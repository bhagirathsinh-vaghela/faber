import { createSimpleContext } from "@opencode-ai/ui/context"
import { useSDK } from "@/context/sdk"
import { useGlobalSync } from "@/context/global-sync"
import { clonePrompt, cloneContext, type ContextItem, type Prompt } from "./prompt"

// Manual prompt stash, owned by the server and shared across all sessions and
// clients. Push throws the current prompt in; the stash dialog lists entries
// and pops one back into the input. The list streams from the server, so every
// tab reflects the same stash live.
export const { use: useStash, provider: StashProvider } = createSimpleContext({
  name: "Stash",
  init: () => {
    const sdk = useSDK()
    const globalSync = useGlobalSync()
    const [store] = globalSync.child(sdk.directory)

    return {
      list() {
        return store.stash
      },
      push(prompt: Prompt, context: ContextItem[] = []) {
        sdk.client.preference.stash
          .push({
            stashEntry: {
              prompt: clonePrompt(prompt),
              context: context.length ? cloneContext(context) : undefined,
              timestamp: Date.now(),
            },
          })
          .catch(() => undefined)
      },
      removeAt(index: number) {
        sdk.client.preference.stash.remove({ index }).catch(() => undefined)
      },
    }
  },
})
