import { For, Show, onCleanup, onMount } from "solid-js"
import { useLanguage } from "@/context/language"
import type { createDictation } from "@/utils/dictation"

// Live transcription HUD (floating panel + dancing level bars, in the style of
// modern dictation apps). Text settles here, not in the host input: Enter hands
// the transcript to onAccept, Escape discards. Both close the mic. If the host
// unmounts mid-dictation the transcript is stashed via onAccept, never dropped.
export function DictationOverlay(props: {
  dictation: ReturnType<typeof createDictation>
  onAccept: (text: string) => void
  onClose: () => void
}) {
  const language = useLanguage()

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

  return (
    <div class="absolute bottom-full inset-x-0 mb-2 z-50 flex justify-center pointer-events-none">
      <div class="pointer-events-auto w-full max-w-xl rounded-2xl border border-border-weak-base bg-surface-raised-stronger-non-alpha shadow-lg backdrop-blur px-4 py-3 flex flex-col gap-2.5">
        <div class="flex items-center gap-3">
          <span class="relative flex size-2 shrink-0">
            <span class="absolute inline-flex size-full rounded-full bg-icon-critical-base opacity-60 animate-ping" />
            <span class="relative inline-flex size-2 rounded-full bg-icon-critical-base" />
          </span>
          <div class="flex items-end gap-[3px] h-7 flex-1" aria-hidden="true">
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
          <div class="flex items-center gap-2 shrink-0">
            <kbd class="text-11-regular text-text-weak rounded border border-border-weak-base px-1.5 py-0.5">
              ↵ {language.t("dictation.accept")}
            </kbd>
            <kbd class="text-11-regular text-text-weak rounded border border-border-weak-base px-1.5 py-0.5">
              esc {language.t("dictation.discard")}
            </kbd>
          </div>
        </div>
        <div
          class="text-13-regular text-text-strong max-h-32 overflow-y-auto whitespace-pre-wrap leading-relaxed"
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
  )
}
