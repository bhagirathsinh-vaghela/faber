import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { Portal } from "solid-js/web"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
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
  let transcriptScroll: HTMLDivElement | undefined
  const setTranscriptScroll = (el: HTMLDivElement) => (transcriptScroll = el)
  // Keep the newest words in view as they arrive: reading committed/interim here
  // ties the scroll to their growth without the transcript element measuring
  // itself.
  createEffect(() => {
    props.dictation.committed()
    props.dictation.interim()
    if (transcriptScroll) transcriptScroll.scrollTop = transcriptScroll.scrollHeight
  })
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
    if (event.key === " ") {
      event.preventDefault()
      event.stopPropagation()
      togglePause()
    }
  }

  const togglePause = () => {
    if (props.dictation.paused()) props.dictation.resume()
    else props.dictation.pause()
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

  // The label is a deep shade of the accent itself rather than flat black or
  // white, so the button stays one hue. The probe resolves the accent (which may
  // be a CSS variable) to measure luminance: a light accent takes a very dark
  // shade of itself, a dark accent a very light one.
  let probe: HTMLSpanElement | undefined
  const [accentText, setAccentText] = createSignal(`color-mix(in srgb, ${accent()} 30%, white)`)
  createEffect(() => {
    if (!probe) return
    const resolved = getComputedStyle(probe).backgroundColor
    const match = resolved.match(/\d+(\.\d+)?/g)
    if (!match) return
    const [r, g, b] = match.map(Number)
    const luminance = (0.299 * r! + 0.587 * g! + 0.114 * b!) / 255
    setAccentText(
      luminance > 0.5
        ? `color-mix(in srgb, ${accent()} 25%, black)`
        : `color-mix(in srgb, ${accent()} 25%, white)`,
    )
  })

  // Elapsed recording time, shown top-right like native dictation apps. It counts
  // only while listening: a pause captures no audio, so its seconds do not belong
  // to the recording.
  const [elapsed, setElapsed] = createSignal(0)
  const timer = setInterval(() => {
    if (props.dictation.listening() && !props.dictation.paused()) setElapsed((s) => s + 1)
  }, 1000)
  onCleanup(() => clearInterval(timer))
  const clock = () => {
    const total = elapsed()
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
  }

  return (
    <Portal>
      <span ref={probe} aria-hidden="true" style={{ position: "absolute", width: 0, height: 0, "background-color": accent() }} />
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
          <div class="shrink-0 flex items-center gap-2 px-3 pt-2">
            <span class="text-11-medium uppercase tracking-wide text-text-weak" aria-live="polite">
              {props.dictation.transcribing()
                ? language.t("dictation.transcribing")
                : props.dictation.paused()
                  ? language.t("dictation.paused")
                  : props.dictation.listening()
                    ? language.t("dictation.listening")
                    : language.t("dictation.starting")}
              …
            </span>
            <div class="ml-auto flex items-center gap-1.5">
              <span class="flex size-2.5 shrink-0">
                <Show
                  when={props.dictation.listening() && !props.dictation.paused()}
                  fallback={<span class="relative inline-flex size-2.5 rounded-full bg-icon-base opacity-50" />}
                >
                  <span class="absolute inline-flex size-2.5 rounded-full bg-icon-critical-base opacity-60 animate-ping" />
                  <span class="relative inline-flex size-2.5 rounded-full bg-icon-critical-base animate-pulse" />
                </Show>
              </span>
              <span class="text-13-medium font-bold tabular-nums text-text-base">{clock()}</span>
            </div>
          </div>
          {/* Chrome on Android composites a promoted canvas layer opaque, so
              the bars arrive on a black rectangle. */}
          <div class="shrink-0 h-16 any-pointer-coarse:h-20 px-3">
            <DictationWaveform
              analyser={props.dictation.analyser}
              live={props.dictation.listening}
              paused={props.dictation.paused}
            />
          </div>
          <Show when={props.dictation.committed() || props.dictation.interim()}>
            <div
              ref={setTranscriptScroll}
              class="mx-2 max-h-32 overflow-y-auto rounded-2xl bg-surface-inset-base px-3.5 py-2.5 text-14-regular text-text-base leading-relaxed"
            >
              {props.dictation.committed()}
              <Show when={props.dictation.interim()}>
                <span class="text-text-weak">
                  {props.dictation.committed() ? " " : ""}
                  {props.dictation.interim()}
                </span>
              </Show>
            </div>
          </Show>
          <div class="shrink-0 flex flex-col items-end gap-2 px-2 pt-1 pb-1">
            <div class="flex items-center gap-2">
              <div class="flex flex-col items-center gap-0.5">
                <kbd class="hidden any-pointer-fine:block text-11-regular text-text-weaker">esc</kbd>
                <IconButton
                  type="button"
                  variant="secondary"
                  size="normal"
                  icon="close"
                  class="size-9 any-pointer-coarse:size-11 rounded-full"
                  aria-label={language.t("dictation.discard")}
                  onClick={() => finish("discard")}
                />
              </div>
              <div class="flex flex-col items-center gap-0.5">
                <kbd class="hidden any-pointer-fine:block text-11-regular text-text-weaker">↵</kbd>
                <IconButton
                  type="button"
                  variant="secondary"
                  size="normal"
                  icon="check"
                  class="size-9 any-pointer-coarse:size-11 rounded-full text-icon-interactive-base"
                  aria-label={language.t("dictation.accept")}
                  onClick={() => finish("accept")}
                />
              </div>
            </div>
            <div class="flex flex-col items-center gap-0.5">
              <button
                type="button"
                data-dictation-pause
                aria-pressed={props.dictation.paused()}
                aria-label={props.dictation.paused() ? language.t("dictation.resume") : language.t("dictation.pause")}
                onClick={togglePause}
                class="flex items-center justify-center gap-2 rounded-xl border pl-4 pr-5 h-12 any-pointer-coarse:h-14 any-pointer-coarse:pl-5 any-pointer-coarse:pr-6 text-15-medium font-bold hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98] transition-transform duration-150"
                style={{
                  color: accentText(),
                  "border-color": accentText(),
                  "background-image": `linear-gradient(180deg, ${accent()} 0%, color-mix(in srgb, ${accent()} 85%, black) 100%)`,
                  "box-shadow": `inset 0 1px 0 color-mix(in srgb, ${accent()} 80%, white)`,
                }}
              >
                <span
                  class="flex size-5 items-center justify-center rounded-md border"
                  style={{ "border-color": accentText() }}
                >
                  <Icon name={props.dictation.paused() ? "play" : "pause"} size="small" style={{ color: accentText() }} />
                </span>
                {props.dictation.paused() ? language.t("dictation.resume") : language.t("dictation.pause")}
              </button>
              <kbd class="hidden any-pointer-fine:block text-11-regular text-text-weaker">space</kbd>
            </div>
          </div>
        </div>
      </div>
    </Portal>
  )
}
