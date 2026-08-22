import { Show, createEffect, onCleanup, onMount } from "solid-js"
import { Portal } from "solid-js/web"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useLanguage } from "@/context/language"
import type { createDictation } from "@/utils/dictation"
import { DictationWaveform } from "./dictation-waveform"

// Live transcription HUD: a compact floating pill with a canvas waveform, in
// the style of modern dictation apps. Text settles here, not in the host
// input: Enter or the check button accepts, Escape or the close button
// discards. All close the mic. If the host unmounts mid-dictation the
// transcript is stashed, never dropped. Portaled to body with a top z-index so
// no ancestor (overflow-clip forms, panels) can hide it.
export function DictationOverlay(props: {
  dictation: ReturnType<typeof createDictation>
  onAccept: (text: string) => void
  // Keeps the transcript without inserting at the target (outside click,
  // host unmount): the host stows it in the prompt draft.
  onStash: (text: string) => void
  onClose: () => void
  // Agent tint for the border, matching the question panel; defaults to the
  // interactive accent when the host has no agent color.
  accent?: string
}) {
  const language = useLanguage()

  let panelRef: HTMLDivElement | undefined
  let transcriptRef: HTMLDivElement | undefined
  let done = false
  const finish = (outcome: "accept" | "stash" | "discard") => {
    done = true
    // Capture the transcript before anything else: stop() clears the store.
    const text = props.dictation.text().trim()
    // Dismiss and hand off the text before releasing the mic, so the frame that
    // closes the overlay and inserts the text carries no audio-teardown work.
    // stop() defers the expensive part past that paint on its own.
    props.onClose()
    if (text && outcome === "accept") props.onAccept(text)
    if (text && outcome === "stash") props.onStash(text)
    props.dictation.stop()
  }

  const handleKey = (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault()
      event.stopPropagation()
      finish("accept")
    }
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      finish("discard")
    }
  }

  // The mic toggle handles its own stop; everything else outside the panel
  // stashes so a stray click never drops the transcript.
  const handlePointer = (event: PointerEvent) => {
    const target = event.target as HTMLElement | null
    if (!target) return
    if (panelRef?.contains(target)) return
    if (target.closest("[data-dictation-toggle]")) return
    finish("stash")
  }

  // The scrim eats clicks (so an outside click only dismisses) but must let
  // the app scroll: find the scrollable element under the cursor and scroll it.
  const forwardWheel = (event: WheelEvent) => {
    const under = document
      .elementsFromPoint(event.clientX, event.clientY)
      .find((el) => el !== event.currentTarget && el.scrollHeight > el.clientHeight)
    under?.scrollBy({ top: event.deltaY, left: event.deltaX })
  }

  onMount(() => {
    document.addEventListener("keydown", handleKey, true)
    document.addEventListener("pointerdown", handlePointer, true)
  })
  onCleanup(() => {
    document.removeEventListener("keydown", handleKey, true)
    document.removeEventListener("pointerdown", handlePointer, true)
    if (done) return
    const text = props.dictation.text().trim()
    props.dictation.stop()
    if (text) props.onStash(text)
  })

  // Keep the newest words visible as the transcript outgrows the box.
  createEffect(() => {
    props.dictation.text()
    transcriptRef?.scrollTo({ top: transcriptRef.scrollHeight })
  })

  const accent = () => props.accent ?? "var(--icon-interactive-base)"

  return (
    <Portal>
      {/* Dim scrim. Captures clicks so an outside click means only "dismiss"
          (handlePointer stashes) and never leaks to the app behind, but
          re-dispatches wheel to the element under the cursor so the app still
          scrolls. */}
      <div
        class="fixed inset-0 z-[9998] overscroll-contain"
        style={{ background: "rgba(0, 0, 0, 0.7)" }}
        onWheel={forwardWheel}
      />
      {/* Anchored just above the prompt dock, so the transcript lands beside
          the input it will be inserted into rather than across the screen from
          it. --prompt-height is published on the root by the dock's resize
          observer; the fallback only covers the frames before it lands. */}
      <div class="fixed inset-x-0 bottom-[calc(var(--prompt-height,8rem)+var(--keyboard-inset,0px)+64px)] z-[9999] flex justify-center pointer-events-none px-4">
        <div
          ref={panelRef}
          class="pointer-events-auto w-full max-w-md flex flex-col gap-2 rounded-[1.75rem] border-[4.5px] bg-surface-raised-stronger-non-alpha p-2 transform-gpu isolate"
          style={{
            "border-color": accent(),
            "box-shadow": `0 0 0 1px color-mix(in srgb, ${accent()} 35%, transparent), 0 0 24px 4px color-mix(in srgb, ${accent()} 30%, transparent), 0 8px 24px rgba(0,0,0,0.4)`,
          }}
        >
          <div class="shrink-0 relative flex items-center justify-center px-2 pt-1">
            <span class="absolute left-3 flex size-2.5 shrink-0">
              <span class="absolute inline-flex size-full rounded-full bg-icon-critical-base opacity-60 animate-ping" />
              <span class="relative inline-flex size-2.5 rounded-full bg-icon-critical-base animate-pulse" />
            </span>
            {/* Chrome on Android composites a promoted canvas layer opaque, so
                the bars arrive on a black rectangle. */}
            <div class="h-6 w-[180px]">
              <DictationWaveform analyser={props.dictation.analyser} />
            </div>
          </div>
          <div
            ref={transcriptRef}
            class="max-h-32 text-13-regular text-text-strong overflow-y-auto whitespace-pre-wrap leading-relaxed px-3 pb-1 pt-0.5"
            aria-live="polite"
          >
            <span class="text-13-medium">{props.dictation.committed()}</span>
            <Show when={props.dictation.interim()}>
              <span class="text-text-weak">{(props.dictation.committed() ? " " : "") + props.dictation.interim()}</span>
            </Show>
            <Show when={!props.dictation.text()}>
              <span class="text-text-weak">{language.t("dictation.listening")}…</span>
            </Show>
          </div>
          <div class="shrink-0 flex flex-row items-end justify-end gap-2 px-2 pb-1">
            <div class="flex flex-col items-center gap-0.5">
              <kbd class="hidden any-pointer-fine:block text-11-regular text-text-weak">esc</kbd>
              <IconButton
                type="button"
                variant="secondary"
                size="large"
                icon="close"
                class="size-8 any-pointer-coarse:size-11"
                aria-label={language.t("dictation.discard")}
                onClick={() => finish("discard")}
              />
            </div>
            <div class="flex flex-col items-center gap-0.5">
              <kbd class="hidden any-pointer-fine:block text-11-regular text-text-weak">↵</kbd>
              <IconButton
                type="button"
                variant="primary"
                size="large"
                icon="check"
                class="size-8 any-pointer-coarse:size-11"
                aria-label={language.t("dictation.accept")}
                onClick={() => finish("accept")}
              />
            </div>
          </div>
        </div>
      </div>
    </Portal>
  )
}
