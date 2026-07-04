import { Component, createMemo } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useStash } from "@/context/stash"
import { usePrompt, type Prompt } from "@/context/prompt"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"

interface StashItem {
  index: number
  text: string
  time: string
  prompt: Prompt
}

function preview(prompt: Prompt): string {
  return prompt
    .filter((p) => p.type === "text")
    .map((p) => p.content)
    .join("")
    .replace(/\n/g, " ")
    .trim()
    .slice(0, 200)
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { timeStyle: "short" })
}

// Stash list: up/down to select, Enter restores into the input and removes the
// entry, the × button deletes an entry without restoring, Escape dismisses. The
// search input is kept (it holds focus so the arrow keys drive the list) but
// hidden, since the user wants a plain list without a visible search box.
export const DialogStash: Component = () => {
  const stash = useStash()
  const prompt = usePrompt()
  const dialog = useDialog()
  const language = useLanguage()
  const command = useCommand()

  const items = createMemo((): StashItem[] =>
    stash
      .list()
      .map((entry, index) => {
        const prompt = entry.prompt as Prompt
        return {
          index,
          text: preview(prompt) || language.t("dialog.stash.empty.item"),
          time: formatTime(entry.timestamp),
          prompt,
        }
      })
      .reverse(),
  )

  const restore = (item: StashItem | undefined) => {
    if (!item) return
    // No data loss: if the input has unsaved text, stash it before restoring
    // the selected entry, so the current draft is swapped into the stash rather
    // than clobbered.
    const current = prompt.dirty() ? prompt.current() : undefined
    dialog.close()
    prompt.set(item.prompt)
    stash.removeAt(item.index)
    if (current) stash.push(current)
    // The stash content is now in the dock, so put the caret there. Deferred so
    // it runs after the dialog tears down, otherwise Kobalte restores focus to
    // the trigger on close and clobbers this.
    requestAnimationFrame(() => command.trigger("prompt.focus"))
  }

  return (
    <Dialog title={language.t("dialog.stash.title")}>
      <List
        class="flex-1 min-h-0 [&_[data-slot=list-search-wrapper]]:sr-only [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0"
        search={{ autofocus: true }}
        emptyMessage={language.t("dialog.stash.empty")}
        key={(x) => String(x.index)}
        items={items}
        filterKeys={["text"]}
        onSelect={restore}
      >
        {(item) => (
          <div class="w-full flex items-center gap-2">
            <span class="truncate flex-1 min-w-0 text-left font-normal">{item.text}</span>
            <span class="text-text-weak shrink-0 font-normal">{item.time}</span>
            <IconButton
              icon="close"
              variant="ghost"
              aria-label={language.t("dialog.stash.remove")}
              onClick={(e) => {
                e.stopPropagation()
                stash.removeAt(item.index)
              }}
            />
          </div>
        )}
      </List>
    </Dialog>
  )
}
