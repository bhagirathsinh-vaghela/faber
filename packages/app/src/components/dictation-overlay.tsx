import { For, Show, createEffect, onCleanup, onMount } from "solid-js"
import { Portal } from "solid-js/web"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import type { createDictation } from "@/utils/dictation"

// Live transcription HUD (floating panel + dancing level bars, in the style of
// modern dictation apps). Text settles here, not in the host input: Enter or
// the check button accepts, Escape or the close button discards. All close the
// mic. If the host unmounts mid-dictation the transcript is stashed via
// onAccept, never dropped. Portaled to body with a top z-index so no ancestor
// (overflow-clip forms, panels) can hide it.
export function DictationOverlay(props: {
  dictation: ReturnType<typeof createDictation>
  onAccept: (text: string) => void
  onClose: () => void
}) {
  const language = useLanguage()

  let transcriptRef: HTMLDivElement | undefined
  let done = false
  const finish = (accept: boolean) => {
    done = true
    const text = props.dictation.text().trim()
    props.dictation.stop()
    props.onClose()
    if (accept && text) props.onAccept(text)
  }

  const handleKey = (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault()
      event.stopPropagation()
      finish(true)
    }
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      finish(false)
    }
  }

  onMount(() => document.addEventListener("keydown", handleKey, true))
  onCleanup(() => {
    document.removeEventListener("keydown", handleKey, true)
    if (done) return
    const text = props.dictation.text().trim()
    props.dictation.stop()
    if (text) props.onAccept(text)
  })

  // Keep the newest words visible as the transcript outgrows the box.
  createEffect(() => {
    props.dictation.text()
    transcriptRef?.scrollTo({ top: transcriptRef.scrollHeight })
  })

  return (
    <Portal>
      <div class="fixed inset-x-0 top-[10%] md:top-[15%] z-[9999] flex justify-center pointer-events-none px-3 md:px-4">
        <div class="pointer-events-auto w-full max-w-2xl rounded-2xl border border-border-weak-base bg-surface-raised-stronger-non-alpha shadow-2xl px-4 py-3 md:px-5 md:py-4 flex flex-col gap-2.5 md:gap-3">
          <div class="flex items-center gap-2.5 md:gap-3">
            <span class="relative flex size-2 shrink-0">
              <span class="absolute inline-flex size-full rounded-full bg-icon-critical-base opacity-60 animate-ping" />
              <span class="relative inline-flex size-2 rounded-full bg-icon-critical-base" />
            </span>
            <div class="flex items-end gap-[2px] md:gap-[3px] h-6 md:h-7 flex-1 min-w-0" aria-hidden="true">
              <For each={props.dictation.levels()}>
                {(level) => (
                  <span
                    class="flex-1 rounded-full bg-icon-primary transition-[height,opacity] duration-75"
                    style={{
                      height: `${Math.max(12, level * 100)}%`,
                      opacity: level > 0.02 ? "1" : "0.35",
                    }}
                  />
                )}
              </For>
            </div>
            <div class="hidden md:flex items-center gap-2 shrink-0">
              <kbd class="text-11-regular text-text-weak rounded border border-border-weak-base px-1.5 py-0.5">
                ↵ {language.t("dictation.accept")}
              </kbd>
              <kbd class="text-11-regular text-text-weak rounded border border-border-weak-base px-1.5 py-0.5">
                esc {language.t("dictation.discard")}
              </kbd>
            </div>
            <div class="flex items-center gap-1 shrink-0">
              <Button
                type="button"
                variant="ghost"
                class="size-7 px-1"
                onClick={() => finish(false)}
                aria-label={language.t("dictation.discard")}
              >
                <Icon name="close" class="size-4.5 text-icon-weak" />
              </Button>
              <Button
                type="button"
                variant="primary"
                class="size-7 px-1"
                onClick={() => finish(true)}
                aria-label={language.t("dictation.accept")}
              >
                <Icon name="check" class="size-4.5" />
              </Button>
            </div>
          </div>
          <div
            ref={transcriptRef}
            class="text-13-regular text-text-strong max-h-[30dvh] md:max-h-40 overflow-y-auto whitespace-pre-wrap leading-relaxed"
            aria-live="polite"
          >
            {props.dictation.committed()}
            <Show when={props.dictation.interim()}>
              <span class="text-text-weak">{(props.dictation.committed() ? " " : "") + props.dictation.interim()}</span>
            </Show>
            <Show when={!props.dictation.text()}>
              <span class="text-text-weak">{language.t("dictation.listening")}…</span>
            </Show>
          </div>
        </div>
      </div>
    </Portal>
  )
}
