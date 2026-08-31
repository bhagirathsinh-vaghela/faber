import { Show, createEffect } from "solid-js"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { RATE, type createSpeech } from "@/utils/speak"
import { OverlayPanel } from "./overlay-panel"

// Playback HUD for an assistant message being read aloud: pause/resume, a speed
// cycle, and a stop, over the shared overlay shell.
export function SpeechOverlay(props: {
  speech: ReturnType<typeof createSpeech>
  onClose: () => void
  accent?: string
}) {
  const language = useLanguage()

  const close = () => {
    props.speech.close()
    props.onClose()
  }

  const toggle = () => {
    if (!props.speech.speaking()) return props.speech.start()
    if (props.speech.paused()) props.speech.resume()
    else props.speech.pause()
  }

  const handleKey = (event: KeyboardEvent) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault()
      event.stopPropagation()
      return props.speech.previous()
    }
    if (event.key === "ArrowRight") {
      event.preventDefault()
      event.stopPropagation()
      return props.speech.next()
    }
    if (event.key !== " ") return
    event.preventDefault()
    event.stopPropagation()
    toggle()
  }

  const transport = () => {
    if (!props.speech.speaking()) return language.t("speech.play")
    return props.speech.paused() ? language.t("speech.resume") : language.t("speech.pause")
  }

  const progress = () => (props.speech.total() ? (props.speech.index() + 1) / props.speech.total() : 0)

  return (
    <OverlayPanel accent={props.accent} onDismiss={close} onKey={handleKey}>
      {({ accent, text: accentText }) => (
        <>
          <div class="shrink-0 flex items-center gap-2 px-3 pt-2">
            <span class="text-11-medium uppercase tracking-wide text-text-weak" aria-live="polite">
              {props.speech.loading()
                ? `${language.t("speech.loading")}…`
                : props.speech.paused()
                  ? `${language.t("speech.paused")}…`
                  : props.speech.speaking()
                    ? `${language.t("speech.speaking")}…`
                    : language.t("speech.ready")}
            </span>
            <div class="ml-auto flex items-center gap-1.5">
              <span class="flex size-2.5 shrink-0">
                <Show
                  when={props.speech.speaking() && !props.speech.paused()}
                  fallback={<span class="relative inline-flex size-2.5 rounded-full bg-icon-base opacity-50" />}
                >
                  <span class="absolute inline-flex size-2.5 rounded-full bg-icon-interactive-base opacity-60 animate-ping" />
                  <span class="relative inline-flex size-2.5 rounded-full bg-icon-interactive-base animate-pulse" />
                </Show>
              </span>
              <span class="text-13-medium font-bold tabular-nums text-text-base">
                {props.speech.index() + 1}/{props.speech.total()}
              </span>
              {/* Only worth offering once the reading is somewhere other than
                  its start, where it would do nothing. */}
              <Show when={props.speech.resuming()}>
                <button
                  type="button"
                  aria-label={language.t("speech.restart")}
                  onClick={props.speech.restart}
                  class="rounded-lg border border-border-base px-2 h-7 text-11-medium text-text-weak hover:text-text-base"
                >
                  {language.t("speech.restart")}
                </button>
              </Show>
            </div>
          </div>
          <div class="shrink-0 mx-3 h-1.5 rounded-full bg-surface-inset-base overflow-hidden">
            <div
              class="h-full rounded-full transition-[width] duration-300"
              style={{ width: `${progress() * 100}%`, "background-color": accent() }}
            />
          </div>
          <Show when={props.speech.chunk()}>
            <div class="mx-2 max-h-24 overflow-y-auto rounded-2xl bg-surface-inset-base px-3.5 py-2.5 text-14-regular text-text-base leading-relaxed">
              {props.speech.chunk()}
            </div>
          </Show>
          <div class="shrink-0 flex items-center justify-between gap-2 px-2 pt-1 pb-1">
            <div class="flex flex-col items-center gap-0.5">
              <div class="flex items-center rounded-xl border border-border-base overflow-hidden">
                <button
                  type="button"
                  aria-label={language.t("speech.slower")}
                  onClick={props.speech.slower}
                  disabled={props.speech.rate() <= RATE.min}
                  class="flex items-center justify-center w-7 h-11 any-pointer-coarse:w-9 any-pointer-coarse:h-13 text-15-medium text-text-weak hover:text-text-base disabled:opacity-30"
                >
                  −
                </button>
                <span
                  class="min-w-11 text-center text-13-medium font-bold tabular-nums text-text-base"
                  aria-label={language.t("speech.speed")}
                  aria-live="polite"
                >
                  {props.speech.rate()}×
                </span>
                <button
                  type="button"
                  aria-label={language.t("speech.faster")}
                  onClick={props.speech.faster}
                  disabled={props.speech.rate() >= RATE.max}
                  class="flex items-center justify-center w-7 h-11 any-pointer-coarse:w-9 any-pointer-coarse:h-13 text-15-medium text-text-weak hover:text-text-base disabled:opacity-30"
                >
                  +
                </button>
              </div>
              <kbd class="hidden any-pointer-fine:block text-11-regular text-text-weaker">speed</kbd>
            </div>
            <div class="flex items-center gap-1.5">
              <IconButton
                type="button"
                variant="secondary"
                size="normal"
                icon="arrow-left"
                class="size-(--control-height) rounded-full"
                disabled={props.speech.index() === 0}
                aria-label={language.t("speech.previous")}
                onClick={props.speech.previous}
              />
              <div class="flex flex-col items-center gap-0.5">
                <button
                  type="button"
                  aria-pressed={props.speech.paused()}
                  aria-label={transport()}
                  onClick={toggle}
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
                      name={props.speech.speaking() && !props.speech.paused() ? "pause" : "play"}
                      size="small"
                      style={{ color: accentText() }}
                    />
                  </span>
                  {transport()}
                </button>
                <kbd class="hidden any-pointer-fine:block text-11-regular text-text-weaker">space</kbd>
              </div>
              <IconButton
                type="button"
                variant="secondary"
                size="normal"
                icon="arrow-right"
                class="size-(--control-height) rounded-full"
                disabled={props.speech.index() >= props.speech.total() - 1}
                aria-label={language.t("speech.next")}
                onClick={props.speech.next}
              />
            </div>
            <div class="flex flex-col items-center gap-0.5">
              <kbd class="hidden any-pointer-fine:block text-11-regular text-text-weaker">esc</kbd>
              <IconButton
                type="button"
                variant="secondary"
                size="normal"
                icon="close"
                class="size-(--control-height) rounded-full"
                aria-label={language.t("speech.stop")}
                onClick={close}
              />
            </div>
          </div>
        </>
      )}
    </OverlayPanel>
  )
}
