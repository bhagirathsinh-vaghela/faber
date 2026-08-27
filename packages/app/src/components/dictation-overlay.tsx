import { Show, onCleanup, onMount } from "solid-js"
import { Portal } from "solid-js/web"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useLanguage } from "@/context/language"
import type { createDictation } from "@/utils/dictation"
import { DictationWaveform } from "./dictation-waveform"

// Live transcription HUD: a compact floating pill with a canvas waveform, in
// the style of modern dictation apps. Text settles here, not in the host
// input: Enter, the check button, or a tap outside accepts, while Escape and
// the close button discard. All close the mic. If the host unmounts
// mid-dictation there is nowhere to insert, so the transcript is stashed rather
// than dropped. Portaled to body with a top z-index so no ancestor
// (overflow-clip forms, panels) can hide it.
export function DictationOverlay(props: {
  dictation: ReturnType<typeof createDictation>
  onAccept: (text: string) => void
  onClose: () => void
  // Agent tint for the border, matching the question panel; defaults to the
  // interactive accent when the host has no agent color.
  accent?: string
}) {
  const language = useLanguage()

  let panelRef: HTMLDivElement | undefined
  let done = false
  const finish = async (outcome: "accept" | "discard") => {
    // The panel stays mounted across settle()'s await, so a stray click or
    // keypress in that window would otherwise deliver the transcript twice.
    if (done) return
    done = true
    if (outcome === "discard") {
      ;(document.activeElement as HTMLElement | null)?.blur()
      props.onClose()
      props.dictation.stop()
      return
    }
    const text = (await props.dictation.settle()).trim()
    ;(document.activeElement as HTMLElement | null)?.blur()
    props.onClose()
    if (text) props.onAccept(text)
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

  // The mic toggle handles its own stop. Anywhere else outside the panel reads
  // as "I am done speaking", so the transcript lands where the dictation
  // started rather than waiting in a draft the user has to go find.
  const handlePointer = (event: PointerEvent) => {
    const target = event.target as HTMLElement | null
    if (!target) return
    if (panelRef?.contains(target)) return
    if (target.closest("[data-dictation-toggle]")) return
    finish("accept")
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
    // Read off props before the await: this component is unmounting, so props
    // may no longer be reachable by the time the transcript resolves.
    const accept = props.onAccept
    props.dictation.settle().then((text) => {
      if (text.trim()) accept(text.trim())
    })
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
      {/* --composer-top is the gap from the viewport bottom to the top of the
          composer, published by PromptInput. The dock's own height is not
          usable here: it also contains the question panel, so it swings with
          UI that has nothing to do with where the transcript lands. */}
      <div class="fixed inset-x-0 bottom-[calc(var(--composer-top,8rem)+16px)] z-[9999] flex justify-center pointer-events-none px-4">
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
              <Show
                when={props.dictation.listening()}
                fallback={<span class="relative inline-flex size-2.5 rounded-full bg-icon-base opacity-40" />}
              >
                <span class="absolute inline-flex size-full rounded-full bg-icon-critical-base opacity-60 animate-ping" />
                <span class="relative inline-flex size-2.5 rounded-full bg-icon-critical-base animate-pulse" />
              </Show>
            </span>
            {/* Chrome on Android composites a promoted canvas layer opaque, so
                the bars arrive on a black rectangle. */}
            <div class="h-6 w-[180px]">
              <DictationWaveform analyser={props.dictation.analyser} live={props.dictation.listening} />
            </div>
          </div>
          <div class="text-13-regular px-3 pb-1 pt-0.5" aria-live="polite">
            {/* Status only, never the transcript: it is delivered to the host
                on accept, so showing it here would flash it for the frames
                between arrival and hand-off. */}
            <span class="text-text-weak">
              {props.dictation.transcribing()
                ? language.t("dictation.transcribing")
                : props.dictation.listening()
                  ? language.t("dictation.listening")
                  : language.t("dictation.starting")}
              …
            </span>
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
