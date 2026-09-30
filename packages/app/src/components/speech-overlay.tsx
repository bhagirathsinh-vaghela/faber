import { createEffect, createMemo, For, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Select } from "@opencode-ai/ui/select"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { useLanguage } from "@/context/language"
import { RATE, VOICES, type createSpeech } from "@/utils/speak"
import { picker } from "@/utils/voice"
import { OverlayPanel } from "./overlay-panel"
import { handle } from "./speech-keys"

// A tooltip portals to the body at z-index 1000 (ui tooltip.css), under the
// overlay's scrim and panel (9998, 9999); Kobalte copies the content's
// z-index onto its positioner, so raising the content lifts the whole tooltip.
const ABOVE = "z-[10001]!"

// Playback HUD for an assistant message being read aloud, over the shared
// overlay shell: the whole rewritten text with the chunk being spoken marked,
// and a transport row of icon buttons in the shape every media player uses.
export function SpeechOverlay(props: {
  speech: ReturnType<typeof createSpeech>
  accent?: string
  // The saved voice preference, empty when none is saved, shown as it is so a
  // saved choice can be cleared back to "Default voice".
  voice?: string
  // Settles once the save has; the store then holds the voice in effect.
  onVoiceChange?: (id: string) => Promise<unknown>
}) {
  const language = useLanguage()

  const close = () => props.speech.close()

  const choice = picker((id) => props.onVoiceChange?.(id) ?? Promise.resolve())
  const shown = () => choice.pending() ?? props.voice ?? ""

  // "Default voice" always leads, so a saved preference can be cleared again. A
  // shown voice outside the list is offered by its id, so the picker never
  // shows blank. The options keep their identity until the set of voices
  // changes: the list rebuilds on a new array, which drops the focused option
  // and closes a list opened while a save settles.
  const unset = createMemo(() => ({ id: "", label: language.t("speech.defaultVoice") }))
  const unknown = createMemo(() => {
    const voice = shown()
    return voice && !VOICES.some((v) => v.id === voice) ? voice : undefined
  })
  const voices = createMemo(() => {
    const voice = unknown()
    return voice ? [unset(), { id: voice, label: voice }, ...VOICES] : [unset(), ...VOICES]
  })
  const selected = () => voices().find((v) => v.id === shown())
  const pick = (id: string) => id !== shown() && choice.pick(id)

  const toggle = () => {
    if (!props.speech.speaking()) return props.speech.start()
    if (props.speech.paused()) props.speech.resume()
    else props.speech.pause()
  }

  const handleKey = (event: KeyboardEvent) =>
    handle(event, {
      ArrowLeft: () => props.speech.previous(),
      ArrowRight: () => props.speech.next(),
      "-": () => props.speech.slower(),
      "+": () => props.speech.faster(),
      "=": () => props.speech.faster(),
      " ": toggle,
    })

  const playing = () => props.speech.speaking() && !props.speech.paused()

  const transport = () => {
    if (!props.speech.speaking()) return language.t("speech.play")
    return props.speech.paused() ? language.t("speech.resume") : language.t("speech.pause")
  }

  const status = () => {
    if (props.speech.loading()) return language.t("speech.loading")
    if (props.speech.paused()) return language.t("speech.paused")
    if (props.speech.speaking()) return language.t("speech.speaking")
    return language.t("speech.ready")
  }

  const progress = () => (props.speech.total() ? (props.speech.index() + 1) / props.speech.total() : 0)

  // Keeps the spoken chunk in view as playback moves; the listener may scroll
  // away to read ahead, and the next chunk brings it back with the least
  // movement.
  let transcript: HTMLDivElement | undefined
  createEffect(() => {
    props.speech.index()
    // The index can reach a chunk before its text arrives; the span renders
    // with the text, so that is the moment to bring it into view.
    props.speech.chunk()
    transcript?.querySelector("[data-current]")?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  })

  return (
    <OverlayPanel accent={props.accent} onDismiss={close} onKey={handleKey}>
      {({ accent, text: accentText }) => (
        <>
          <div class="shrink-0 flex items-center gap-2 pl-3 pr-1.5 pt-1.5 min-h-8">
            <span
              class="inline-flex size-2 shrink-0 rounded-full"
              classList={{ "animate-pulse": playing() }}
              style={{ "background-color": playing() ? accent() : "var(--icon-disabled)" }}
            />
            <span class="text-12-medium text-text-weak" aria-live="polite">
              {status()}
            </span>
            <Show when={props.speech.total()}>
              <span class="text-12-regular tabular-nums text-text-weaker">
                {props.speech.index() + 1}
                <span class="mx-0.5 opacity-60">/</span>
                {props.speech.total()}
              </span>
            </Show>
            <div class="ml-auto flex items-center gap-0.5">
              <Show when={props.onVoiceChange}>
                <Select
                  options={voices()}
                  current={selected()}
                  value={(v) => v.id}
                  label={(v) => v.label}
                  onSelect={(v) => v && pick(v.id)}
                  variant="ghost"
                  size="small"
                  // The list must sit above the overlay's z-[9998] scrim; the
                  // component puts its own class on the list and the trigger alike.
                  class="z-[10000]!"
                  valueClass="max-w-36 truncate text-12-regular text-text-weak"
                  aria-label={language.t("speech.voice")}
                />
              </Show>
              {/* Only worth offering once the reading is somewhere other than
                  its start, where it would do nothing. */}
              <Show when={props.speech.resuming()}>
                <Tooltip value={language.t("speech.restart")} placement="top" contentClass={ABOVE}>
                  <IconButton
                    type="button"
                    variant="ghost"
                    size="normal"
                    icon="rotate-left"
                    class="rounded-full"
                    aria-label={language.t("speech.restart")}
                    onClick={props.speech.restart}
                  />
                </Tooltip>
              </Show>
            </div>
          </div>
          <div
            ref={transcript}
            class="mx-1.5 max-h-[30dvh] overflow-y-auto rounded-xl px-3.5 py-3 text-14-regular leading-[1.7] text-text-weak scroll-py-3"
            style={{ "background-color": `color-mix(in srgb, var(--surface-inset-base) 55%, transparent)` }}
          >
            <Show
              when={props.speech.chunks().length}
              fallback={
                <span
                  class="inline-block h-4 w-2/3 animate-pulse rounded-sm bg-text-weaker/30 align-middle"
                  aria-hidden="true"
                />
              }
            >
              <p class="m-0">
                <For each={props.speech.chunks()}>
                  {(text, at) => (
                    <>
                      <span
                        data-current={at() === props.speech.index() ? "" : undefined}
                        class="rounded-md box-decoration-clone px-0.5 -mx-0.5 transition-colors duration-300"
                        classList={{
                          "text-text-base": at() === props.speech.index(),
                          "text-text-weaker": at() < props.speech.index(),
                        }}
                        style={{
                          "background-color":
                            at() === props.speech.index()
                              ? `color-mix(in srgb, ${accent()} 22%, transparent)`
                              : undefined,
                        }}
                      >
                        {text}
                      </span>{" "}
                    </>
                  )}
                </For>
              </p>
            </Show>
          </div>
          <div class="shrink-0 mx-3 h-0.5 rounded-full bg-surface-inset-base overflow-hidden">
            <div
              class="h-full rounded-full transition-[width] duration-300"
              style={{ width: `${progress() * 100}%`, "background-color": accent() }}
            />
          </div>
          {/* One row when the side columns can hold the speed control, so the
              transport sits dead centre; on a narrower panel (a phone) the
              transport takes its own centred row and speed and stop go below
              it, since equal side columns no longer fit beside it. */}
          <div class="shrink-0 @container/transport">
            <div class="grid grid-cols-[1fr_auto_1fr] items-center gap-y-1 px-2 pb-1.5 pt-0.5">
              <div class="flex justify-start col-start-1 row-start-2 @min-[27rem]/transport:row-start-1">
                <div
                  class="flex h-(--control-height) items-stretch rounded-full border border-border-base overflow-hidden"
                  role="group"
                  aria-label={language.t("speech.speed")}
                >
                  <TooltipKeybind title={language.t("speech.slower")} keybind="−" placement="top" contentClass={ABOVE}>
                    <button
                      type="button"
                      aria-label={language.t("speech.slower")}
                      onClick={props.speech.slower}
                      disabled={props.speech.rate() <= RATE.min}
                      class="flex w-8 any-pointer-coarse:w-10 items-center justify-center text-14-medium text-text-weak hover:text-text-base hover:bg-surface-inset-base disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
                    >
                      −
                    </button>
                  </TooltipKeybind>
                  <span
                    class="flex min-w-11 items-center justify-center text-12-medium tabular-nums text-text-base"
                    aria-live="polite"
                  >
                    {props.speech.rate()}×
                  </span>
                  <TooltipKeybind title={language.t("speech.faster")} keybind="+" placement="top" contentClass={ABOVE}>
                    <button
                      type="button"
                      aria-label={language.t("speech.faster")}
                      onClick={props.speech.faster}
                      disabled={props.speech.rate() >= RATE.max}
                      class="flex w-8 any-pointer-coarse:w-10 items-center justify-center text-14-medium text-text-weak hover:text-text-base hover:bg-surface-inset-base disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
                    >
                      +
                    </button>
                  </TooltipKeybind>
                </div>
              </div>
              <div class="flex items-center gap-2 col-span-3 row-start-1 justify-self-center @min-[27rem]/transport:col-span-1 @min-[27rem]/transport:col-start-2">
                <TooltipKeybind title={language.t("speech.previous")} keybind="←" placement="top" contentClass={ABOVE}>
                  <IconButton
                    type="button"
                    variant="ghost"
                    size="large"
                    icon="skip-back"
                    class="rounded-full"
                    disabled={props.speech.index() === 0}
                    aria-label={language.t("speech.previous")}
                    onClick={props.speech.previous}
                  />
                </TooltipKeybind>
                <TooltipKeybind title={transport()} keybind="space" placement="top" contentClass={ABOVE}>
                  <button
                    type="button"
                    aria-pressed={props.speech.paused()}
                    aria-label={transport()}
                    onClick={toggle}
                    class="flex size-14 any-pointer-coarse:size-16 items-center justify-center rounded-full transition-transform duration-150 hover:scale-105 active:scale-95 [&_[data-component=icon]]:size-7 any-pointer-coarse:[&_[data-component=icon]]:size-8"
                    style={{
                      color: accentText(),
                      "background-color": accent(),
                      "box-shadow": `0 6px 18px color-mix(in srgb, ${accent()} 35%, transparent)`,
                    }}
                  >
                    <Icon
                      name={playing() ? "pause-filled" : "play-filled"}
                      size="large"
                      style={{ color: accentText() }}
                    />
                  </button>
                </TooltipKeybind>
                <TooltipKeybind title={language.t("speech.next")} keybind="→" placement="top" contentClass={ABOVE}>
                  <IconButton
                    type="button"
                    variant="ghost"
                    size="large"
                    icon="skip-forward"
                    class="rounded-full"
                    disabled={props.speech.index() >= props.speech.total() - 1}
                    aria-label={language.t("speech.next")}
                    onClick={props.speech.next}
                  />
                </TooltipKeybind>
              </div>
              <div class="flex justify-end col-start-3 row-start-2 @min-[27rem]/transport:row-start-1">
                <TooltipKeybind title={language.t("speech.stop")} keybind="esc" placement="top" contentClass={ABOVE}>
                  <IconButton
                    type="button"
                    variant="ghost"
                    size="normal"
                    icon="close"
                    class="rounded-full"
                    aria-label={language.t("speech.stop")}
                    onClick={close}
                  />
                </TooltipKeybind>
              </div>
            </div>
          </div>
        </>
      )}
    </OverlayPanel>
  )
}
