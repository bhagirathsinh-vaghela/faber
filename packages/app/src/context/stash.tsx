import { createSimpleContext } from "@opencode-ai/ui/context"
import { showToast } from "@opencode-ai/ui/toast"
import { useSDK } from "@/context/sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { clonePrompt, cloneContext, type ContextItem, type Prompt } from "./prompt"

export const STASH_TOAST_MS = 2000

// Manual prompt stash, owned by the server and shared across all sessions and
// clients. Push throws the current prompt in; the stash dialog lists entries
// and pops one back into the input. The list streams from the server, so every
// tab reflects the same stash live.
export const { use: useStash, provider: StashProvider } = createSimpleContext({
  name: "Stash",
  init: () => {
    const sdk = useSDK()
    const globalSync = useGlobalSync()
    const language = useLanguage()
    const [store] = globalSync.child(sdk.directory)

    return {
      list() {
        return store.stash
      },
      // Resolves false when the server did not take the entry, so a caller about
      // to clear or overwrite the input can keep the draft instead of losing it.
      // `note` replaces the default toast; `false` suppresses it for a caller
      // that reports the stash inside its own toast.
      push(prompt: Prompt, context: ContextItem[] = [], note?: { title: string; description?: string } | false) {
        return sdk.client.preference.stash
          .push({
            stashEntry: {
              prompt: clonePrompt(prompt),
              context: context.length ? cloneContext(context) : undefined,
              timestamp: Date.now(),
            },
          })
          .then(() => {
            if (note !== false)
              showToast({ ...(note ?? { title: language.t("stash.toast.saved") }), duration: STASH_TOAST_MS })
            return true
          })
          .catch(() => {
            showToast({ variant: "error", title: language.t("stash.toast.failed"), duration: STASH_TOAST_MS })
            return false
          })
      },
      removeAt(index: number) {
        return sdk.client.preference.stash.remove({ index }).catch(() => undefined)
      },
    }
  },
})
