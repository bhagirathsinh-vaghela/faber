import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { persisted, Persist } from "@/utils/persist"
import { clonePrompt, type Prompt } from "./prompt"

export type StashEntry = {
  prompt: Prompt
  timestamp: number
}

const MAX_ENTRIES = 50

// Manual prompt stash, persisted in this browser's localStorage and shared
// across all sessions (Persist.global). Push throws the current prompt in;
// the stash dialog lists entries and pops one back into the input.
export const { use: useStash, provider: StashProvider } = createSimpleContext({
  name: "Stash",
  init: () => {
    const [store, setStore] = persisted(
      Persist.global("prompt.stash.v1"),
      createStore<{ entries: StashEntry[] }>({ entries: [] }),
    )

    return {
      list() {
        return store.entries
      },
      push(prompt: Prompt) {
        setStore(
          "entries",
          produce((entries) => {
            entries.push({ prompt: clonePrompt(prompt), timestamp: Date.now() })
            if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
          }),
        )
      },
      removeAt(index: number) {
        setStore(
          "entries",
          produce((entries) => {
            if (index >= 0 && index < entries.length) entries.splice(index, 1)
          }),
        )
      },
    }
  },
})
