import { createSignal, For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Popover } from "@opencode-ai/ui/popover"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useSDK } from "@/context/sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"

// Pulls a transcript from the shared dictation pool into a composer. The pool is
// fed by companion devices; tapping an entry inserts it via the host's own
// insert path and removes it from the pool (consume-on-tap). Hidden while the
// pool is empty so it only appears when there's something to grab.
export function DictationPoolButton(props: { onInsert: (text: string) => void }) {
  const sdk = useSDK()
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)

  const take = (id: string, text: string) => {
    props.onInsert(text)
    sdk.client.dictation.pool.remove({ id }).catch(() => undefined)
    setOpen(false)
  }

  return (
    <Show when={globalSync.data.pool.length > 0}>
      <Popover
        open={open()}
        onOpenChange={setOpen}
        placement="top"
        gutter={6}
        triggerAs={Button}
        triggerProps={{ type: "button", variant: "ghost", class: "size-6 px-1" }}
        trigger={
          <Tooltip placement="top" value={language.t("dictation.pool.button")}>
            <Icon name="mic" class="size-4.5 text-icon-interactive-base" />
          </Tooltip>
        }
        class="w-[280px] max-w-[calc(100vw-40px)]"
      >
        <div class="flex flex-col p-1">
          <For each={globalSync.data.pool}>
            {(entry) => (
              <button
                type="button"
                class="text-left text-13-regular text-text-base px-2 py-1.5 rounded-md hover:bg-surface-raised-base-hover transition-colors"
                onClick={() => take(entry.id, entry.text)}
              >
                {entry.text}
              </button>
            )}
          </For>
        </div>
      </Popover>
    </Show>
  )
}
