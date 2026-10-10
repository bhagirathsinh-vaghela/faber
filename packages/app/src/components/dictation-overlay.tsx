import { Show, createEffect, createSignal, onCleanup } from "solid-js"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { type createDictation } from "@/utils/dictation"
import { DictationWaveform } from "./dictation-waveform"
import { OverlayPanel } from "./overlay-panel"

// Live transcription HUD: a compact floating pill with a canvas waveform, in
// the style of modern dictation apps. Text settles here, not in the host
// input: Enter, the check button, or a tap outside accepts, while Escape and
// the close button discard. All close the mic. Unmounting mid-dictation
// (the host's mic toggle, or the host itself going away) settles the
// transcript and still hands it to onAccept rather than dropping it.
// Portaled to body with a top z-index so no ancestor
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

  onCleanup(() => {
    if (done) return
    // Read off props before the await: this component is unmounting, so props
    // may no longer be reachable by the time the transcript resolves.
    const accept = props.onAccept
    props.dictation.settle().then((text) => {
      if (text.trim()) accept(text.trim())
    })
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
    // A pointer outside the panel reads as "I am done speaking", so it accepts
    // rather than discards; the mic toggle is exempt because it handles its own
    // stop.
    <OverlayPanel
      accent={props.accent}
      onDismiss={() => finish("accept")}
      onEscape={() => finish("discard")}
      onKey={handleKey}
      ignore="[data-dictation-toggle]"
    >
      {({ accent, text: accentText }) => (
        <>
          <div class="shrink-0 flex items-center gap-2 px-3 pt-2">
            <span class="text-11-medium uppercase tracking-wide text-text-weak" aria-live="polite">
              {props.dictation.recovering()
                ? language.t("dictation.recovering")
                : props.dictation.transcribing()
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
              class="mx-2 max-h-32 overflow-y-auto rounded-xl bg-surface-inset-base px-3.5 py-2.5 text-14-regular text-text-base leading-relaxed"
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
                  class="size-(--control-height) rounded-full"
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
                  class="size-(--control-height) rounded-full text-icon-interactive-base"
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
                  <Icon
                    name={props.dictation.paused() ? "play" : "pause"}
                    size="small"
                    style={{ color: accentText() }}
                  />
                </span>
                {props.dictation.paused() ? language.t("dictation.resume") : language.t("dictation.pause")}
              </button>
              <kbd class="hidden any-pointer-fine:block text-11-regular text-text-weaker">space</kbd>
            </div>
          </div>
        </>
      )}
    </OverlayPanel>
  )
}
