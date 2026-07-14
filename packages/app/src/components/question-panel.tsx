import { createStore } from "solid-js/store"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import type { QuestionRequest } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Markdown } from "@opencode-ai/ui/markdown"
import { captureFocus } from "@opencode-ai/ui/util/focus"
import { useSDK } from "@/context/sdk"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useQuestion } from "@/context/question"
import { useLocal } from "@/context/local"
import { useLayout } from "@/context/layout"
import { useSettings } from "@/context/settings"
import { agentColor } from "@/utils/agent"
import { createDictation, dictationActive } from "@/utils/dictation"
import { createCoarsePointer } from "@/utils/mobile"
import { DictationOverlay } from "@/components/dictation-overlay"
import { DictationPoolButton } from "@/components/dictation-pool-button"
import { clonePrompt, usePrompt } from "@/context/prompt"
import { showToast } from "@opencode-ai/ui/toast"

// Pinned question prompt. Mirrors the TUI QuestionPrompt
// (packages/opencode/src/cli/cmd/tui/routes/session/question.tsx): tabbed
// multi-question/multi-request flow, single-question fast path, custom answers,
// multi-select, and review/confirm.
//
// The question blocks server-side; the ping daemon keeps the cache warm, so the
// web panel offers collapse (not defer). Collapse shrinks the floating panel to
// a one-line bar near the dock without answering — the question stays pending.
// A new question auto-expands. (Defer stays for the TUI, which cannot collapse.)
export function QuestionPanel(props: { onClose?: () => void }) {
  const command = useCommand()
  const language = useLanguage()
  const question = useQuestion()
  const local = useLocal()
  const layout = useLayout()
  const settings = useSettings()

  // Agent-tinted accent, same as the expanded panel's focused border. The
  // collapsed bar keeps this thin accent even while unfocused so it stays
  // attention-seeking (a live question is still blocking in the background).
  const accent = createMemo(() => {
    const a = local.agent.current()
    return (a && agentColor(a.name, a.color)) ?? "var(--icon-interactive-base)"
  })

  // A newly-arrived question pops the panel open or seeds the one-line bar,
  // driven by the "question" row of the box-defaults matrix for the current
  // mode (ticked = collapsed).
  const applyDefault = () => {
    const mode = layout.zen.opened() ? "zen" : "normal"
    if (settings.boxes.collapsed("question", mode)) question.collapse()
    else question.expand()
  }
  createEffect(
    on(
      () => question.pending().length,
      (len, prev) => {
        if (len > (prev ?? 0)) applyDefault()
      },
    ),
  )
  // Mode switch re-applies the target mode's default to a pending panel — same
  // contract as the transcript boxes, whose manual state resets on mode change.
  createEffect(
    on(
      () => layout.zen.opened(),
      () => {
        if (question.count > 0) applyDefault()
      },
      { defer: true },
    ),
  )

  command.register(() => [
    {
      id: "question.list",
      title: language.t("command.question.list"),
      description: language.t("command.question.list.description"),
      category: language.t("command.category.session"),
      keybind: "alt+y",
      disabled: question.count === 0,
      onSelect: () => question.expand(),
    },
  ])

  // Earliest ask-time across pending requests — the "asked at" the user sees.
  const asked = createMemo(() => {
    const times = question.requests().map((r) => r.time)
    return times.length ? Math.min(...times) : undefined
  })

  return (
    <Show when={question.count > 0}>
      <Show
        when={!question.collapsed()}
        fallback={
          <button
            type="button"
            class="mb-3 flex w-full flex-row items-center gap-2 rounded-md border bg-background-base/95 px-4 py-2 text-left shadow-md hover:bg-background-element"
            style={{ "border-color": accent() }}
            onClick={question.expand}
            data-component="question-collapsed"
          >
            <Icon name="help" class="text-text-weak" />
            <span class="text-13-regular text-text-base">
              {language.t("question.collapsed", { count: question.total() })}
            </span>
            <Show when={asked()}>
              <span class="ml-auto text-11-regular text-text-weak tabular-nums">{clock(asked()!)}</span>
            </Show>
            <div
              data-slot="collapsible-arrow"
              class="flex h-6 w-6 shrink-0 items-center justify-center text-text-weak"
              classList={{ "ml-auto": !asked() }}
            >
              <Icon name="chevron-grabber-vertical" size="small" />
            </div>
          </button>
        }
      >
        <Panel
          requests={question.requests()}
          pendingIDs={question.pendingIDs()}
          asked={asked()}
          onCollapse={() => {
            question.collapse()
            // Collapse hands the dock back the keyboard (caret to end), same as
            // answering/dismissing — the question stays live in the background.
            command.trigger("prompt.focus")
          }}
          onClose={props.onClose}
        />
      </Show>
    </Show>
  )
}

// Short wall-clock "asked at", matching dialog-stash / dialog-fork.
function clock(ms: number) {
  return new Date(ms).toLocaleTimeString(undefined, { timeStyle: "short" })
}

function Panel(props: {
  requests: QuestionRequest[]
  pendingIDs: Set<string>
  asked?: number
  onCollapse: () => void
  onClose?: () => void
}) {
  const sdk = useSDK()
  const local = useLocal()
  const language = useLanguage()

  // Focus-highlight accent = the current session agent's color (same color the
  // dock/agent indicator uses), so the panel's focus cue matches whoever's
  // driving. Falls back to the interactive accent when no agent is resolved.
  const accent = createMemo(() => {
    const a = local.agent.current()
    return (a && agentColor(a.name, a.color)) ?? "var(--icon-interactive-base)"
  })

  const [requestIndex, setRequestIndex] = createSignal(0)
  const request = createMemo(() => props.requests[requestIndex()] ?? props.requests[0])
  const multiRequest = createMemo(() => props.requests.length > 1)
  // Total question count across all pending requests, for the header label
  // (same string the collapsed bar uses).
  const questionCount = createMemo(() => props.requests.reduce((n, r) => n + r.questions.length, 0))

  const questions = createMemo(() => request()?.questions ?? [])
  const single = createMemo(() => questions().length === 1 && questions()[0]?.multiple !== true)
  const tabs = createMemo(() => (single() ? 1 : questions().length + 1))

  const [store, setStore] = createStore({
    tab: 0,
    answers: [] as string[][],
    custom: [] as string[],
    selected: 0,
    editing: false,
  })

  let input: HTMLTextAreaElement | undefined

  // Soft-keyboard suppression on touch devices, mirroring the prompt input: the
  // custom-answer textarea is dictation-first on mobile, so inputmode="none"
  // keeps the OS keyboard down (it fights the dictation overlay) while the
  // keyboard-toggle button opts in per edit session. Reset when editing ends.
  const coarse = createCoarsePointer()
  const [keyboardWanted, setKeyboardWanted] = createSignal(false)
  const suppressKeyboard = () => coarse() && !keyboardWanted()
  const requestKeyboard = () => {
    setKeyboardWanted(true)
    requestAnimationFrame(() => input?.focus())
  }
  // Leaving edit mode resets the opt-in so the next edit is suppressed again.
  createEffect(() => {
    if (!store.editing) setKeyboardWanted(false)
  })

  const promptDraft = usePrompt()
  const promptEmpty = () => promptDraft.current().every((part) => part.type === "text" && part.content.trim() === "")
  const [dictating, setDictating] = createSignal(false)
  const dictation = createDictation({
    url: () => sdk.url,
    onError: (message) => {
      setDictating(false)
      showToast({
        title: language.t("prompt.toast.dictationFailed.title"),
        description: message,
      })
    },
  })
  const stashDictation = (text: string) => {
    // The prompt draft outlives this panel, so the transcript survives even
    // when the question is answered or dismissed mid-dictation.
    promptDraft.set([
      ...clonePrompt(promptDraft.current()),
      { type: "text", content: " " + text + " ", start: 0, end: 0 },
    ])
    showToast({
      title: language.t("dictation.stashed.title"),
      description: language.t("dictation.stashed.description"),
      duration: 2000,
    })
  }
  const acceptDictation = (text: string) => {
    if (!input?.isConnected) {
      stashDictation(text)
      return
    }
    input.value = (input.value ? input.value + " " : "") + text
    input.focus()
  }

  // Whether keyboard focus is currently within the panel. Drives the panel
  // border color and gates hover/selection highlighting so the user can tell
  // at a glance whether their keystrokes drive the question (focused → accent
  // border, highlights live) or the dock/prompt (not focused → default border,
  // no highlight). Starts true: the panel grabs focus on mount.
  const [focused, setFocused] = createSignal(true)

  const question = createMemo(() => questions()[store.tab])
  const confirm = createMemo(() => !single() && store.tab === questions().length)
  const options = createMemo(() => question()?.options ?? [])
  const custom = createMemo(() => question()?.custom !== false)
  // Gated on focus so the custom row shows no highlight when the panel is
  // defocused (parity with option rows). Only drives styling here.
  const other = createMemo(() => focused() && custom() && store.selected === options().length)
  const customText = createMemo(() => store.custom[store.tab] ?? "")
  const multi = createMemo(() => question()?.multiple === true)
  const customPicked = createMemo(() => {
    const value = customText()
    if (!value) return false
    return store.answers[store.tab]?.includes(value) ?? false
  })

  const isPending = (id: string) => props.pendingIDs.has(id)

  function resetForRequest() {
    setStore({ tab: 0, answers: [], custom: [], selected: 0, editing: false })
  }

  function submit() {
    const r = request()
    if (!r) return
    const answers = questions().map((_, i) => store.answers[i] ?? [])
    if (isPending(r.id)) sdk.client.question.reply({ requestID: r.id, answers })
  }

  function reject() {
    const r = request()
    if (!r) return
    if (isPending(r.id)) sdk.client.question.reject({ requestID: r.id })
  }

  function pick(answer: string, isCustom = false) {
    const answers = [...store.answers]
    answers[store.tab] = [answer]
    setStore("answers", answers)
    if (isCustom) {
      const inputs = [...store.custom]
      inputs[store.tab] = answer
      setStore("custom", inputs)
    }
    if (single()) {
      const r = request()
      if (!r) return
      if (isPending(r.id)) sdk.client.question.reply({ requestID: r.id, answers: [[answer]] })
      return
    }
    setStore("tab", store.tab + 1)
    setStore("selected", 0)
    // A mouse click on an option leaves DOM focus on that button, which then
    // unmounts as the tab advances and focus falls to <body>. Keyboard Enter
    // never leaves the panel. Pull focus back so both paths behave the same and
    // the next tab keeps driving from the keyboard.
    panel?.focus()
  }

  function toggle(answer: string) {
    const next = [...(store.answers[store.tab] ?? [])]
    const index = next.indexOf(answer)
    if (index === -1) next.push(answer)
    else next.splice(index, 1)
    const answers = [...store.answers]
    answers[store.tab] = next
    setStore("answers", answers)
  }

  function selectTab(index: number) {
    setStore("tab", index)
    setStore("selected", 0)
  }

  function cycleRequest(direction: number) {
    const len = props.requests.length
    if (len <= 1) return
    setRequestIndex((prev) => (prev + direction + len) % len)
    resetForRequest()
  }

  function activate(index: number) {
    setStore("selected", index)
    if (index === options().length) {
      setStore("editing", true)
      queueMicrotask(() => input?.focus())
      return
    }
    const opt = options()[index]
    if (!opt) return
    if (multi()) {
      toggle(opt.label)
      return
    }
    pick(opt.label)
  }

  function submitCustom() {
    const text = input?.value.trim() ?? ""
    if (!text) {
      setStore("editing", false)
      panel?.focus()
      return
    }
    if (multi()) {
      const inputs = [...store.custom]
      inputs[store.tab] = text
      setStore("custom", inputs)
      if (!(store.answers[store.tab] ?? []).includes(text)) toggle(text)
      setStore("editing", false)
      panel?.focus()
      return
    }
    setStore("editing", false)
    // A single-question request answers and unmounts here (onClose hands focus
    // to the dock). A multi-question request stays open on the next tab, so pull
    // focus back to the panel off the vanishing textarea to keep driving it.
    if (!single()) panel?.focus()
    pick(text, true)
  }

  const total = createMemo(() => options().length + (custom() ? 1 : 0))

  function move(direction: number) {
    const count = total()
    if (count === 0) return
    setStore("selected", (store.selected + direction + count) % count)
  }

  function cycleTab(direction: number) {
    if (multiRequest()) {
      cycleRequest(direction)
      return
    }
    if (single()) return
    selectTab((store.tab + direction + tabs()) % tabs())
  }

  let panel: HTMLDivElement | undefined

  // The capture-phase keydown handler runs before any focused element (prompt
  // contenteditable included) sees the key, and both preventDefault +
  // stopPropagation on the keys it consumes so the prompt's own handler never
  // fires — the question is answered before anything else can be typed. Keys it
  // does NOT consume fall through untouched, so unrelated global keybinds (zen,
  // the palette) keep working while a question is up. The custom-answer textarea
  // is the one exception: it keeps its own Enter/Escape handling, so yield while
  // it has focus.
  function handleKey(event: KeyboardEvent) {
    if (store.editing) return

    // Yield while the user is typing in an editable field (the prompt
    // contenteditable, a textarea, an input). The panel grabs focus on mount so
    // arrows drive the question by default; if the user deliberately clicks into
    // the prompt to type, Enter and arrows belong to the prompt, not the panel.
    const active = document.activeElement as HTMLElement | null
    if (active && active !== panel) {
      const editable = active.isContentEditable || active.tagName === "TEXTAREA" || active.tagName === "INPUT"
      if (editable) return
    }

    const stop = () => {
      event.preventDefault()
      event.stopPropagation()
    }

    if (event.altKey && event.code === "KeyD") {
      stop()
      reject()
      return
    }

    switch (event.key) {
      case "ArrowUp":
        stop()
        move(-1)
        return
      case "ArrowDown":
        stop()
        move(1)
        return
      case "ArrowLeft":
        stop()
        cycleTab(-1)
        return
      case "ArrowRight":
        stop()
        cycleTab(1)
        return
      case "Tab":
        stop()
        cycleTab(event.shiftKey ? -1 : 1)
        return
      case " ":
        // Space toggles the current option in multi-select (parity with Enter's
        // toggle there). In single-select Space does nothing — Enter submits.
        if (!confirm() && multi()) {
          stop()
          activate(store.selected)
        }
        return
      case "Enter":
        stop()
        if (confirm()) submit()
        else activate(store.selected)
        return
      case "Escape":
        stop()
        props.onCollapse()
        return
    }
  }

  function trackFocus() {
    setFocused(Boolean(panel && panel.contains(document.activeElement)))
  }

  // When the panel is not focused, the first interaction anywhere inside it
  // only grabs focus — it must NOT land on a choice and auto-pick it. Guard on
  // mousedown (capture), not click: pressing a button fires focus→focusin
  // BEFORE the click, which would flip `focused` true and let the click through
  // to the choice. At mousedown time focus has not moved yet, so `focused()`
  // still reflects the pre-interaction state. preventDefault stops the button
  // from taking focus; we focus the panel instead. Once focused, interactions
  // fall through and select/toggle normally.
  let swallowClick = false
  function guardMouseDown(event: MouseEvent) {
    if (focused()) return
    // The collapse header always acts, focused or not — it never picks a choice,
    // so it must not be swallowed by the defocused-press guard.
    if ((event.target as HTMLElement | null)?.closest("[data-question-collapse]")) return
    // Defocused press: take focus for the panel, not the button, and remember
    // to swallow the click this press will generate so no choice is picked.
    event.preventDefault()
    event.stopPropagation()
    swallowClick = true
    panel?.focus()
    setFocused(true)
  }
  function guardClick(event: MouseEvent) {
    if (!swallowClick) return
    swallowClick = false
    event.preventDefault()
    event.stopPropagation()
  }

  onMount(() => {
    // Snapshot the surface the question interrupted (usually the prompt) so
    // close hands focus back there. Capture before blurring, while it still
    // holds focus.
    const restore = captureFocus()
    // Only seize focus when the user isn't mid-thought in the prompt: a typed
    // draft or an open dictation overlay owns the focus, and moving the glowy
    // focus border to the question would make it ambiguous who's active.
    if (!dictationActive() && promptEmpty()) {
      ;(document.activeElement as HTMLElement | null)?.blur()
      panel?.focus()
    }
    trackFocus()
    document.addEventListener("keydown", handleKey, true)
    document.addEventListener("focusin", trackFocus)
    document.addEventListener("focusout", trackFocus)
    panel?.addEventListener("mousedown", guardMouseDown, true)
    panel?.addEventListener("click", guardClick, true)
    onCleanup(() => {
      document.removeEventListener("keydown", handleKey, true)
      document.removeEventListener("focusin", trackFocus)
      document.removeEventListener("focusout", trackFocus)
      panel?.removeEventListener("mousedown", guardMouseDown, true)
      panel?.removeEventListener("click", guardClick, true)
      // The panel blurred the dock on mount and owns focus for its lifetime, so
      // hand focus back on close. Only when focus is still loose (on the panel
      // or fallen to <body>): a deliberate click into another field during the
      // panel's life keeps its focus, matching "focus stays unless I click away".
      const active = document.activeElement
      if (!active || active === document.body || (panel && panel.contains(active))) {
        // Prefer the interrupted surface; fall back to onClose (the prompt) when
        // it unmounted while the question was up.
        if (!restore()) props.onClose?.()
      }
    })
  })

  return (
    <div
      ref={(el) => (panel = el)}
      tabindex={-1}
      // max-h caps the panel to the viewport so a tall question (many options /
      // long descriptions) can't grow past the top of the screen inside the
      // bottom-pinned dock. dvh (not vh) tracks mobile browser chrome, matching
      // #root's h-dvh; 16rem leaves room for the dock's pt-12, the prompt input
      // below, and the bottom safe-area. The content div scrolls; the collapse
      // control and actions row stay pinned.
      class="relative mb-3 flex max-h-[calc(100dvh-16rem)] flex-col overflow-hidden rounded-md border bg-background-base/95 shadow-md outline-none transition-[border-color,box-shadow]"
      classList={{ "border-border-base cursor-default": !focused() }}
      style={
        focused()
          ? {
              "border-color": accent(),
              // Subtle soft glow so the focused panel reads as the element to
              // attend to; agent-tinted, low opacity.
              "box-shadow": `0 0 0 1px color-mix(in srgb, ${accent()} 35%, transparent), 0 0 12px 2px color-mix(in srgb, ${accent()} 22%, transparent)`,
            }
          : undefined
      }
      data-component="question-panel"
    >
      {/* Full-width clickable header, matching the collapsible boxes in the
          transcript: the whole bar toggles (here: collapses). Mirrors the
          collapsed one-line bar's layout (help icon, label, asked-at, grabber)
          so expanding/collapsing looks identical. data-question-collapse exempts
          it from the defocused-press guard so the first click always collapses. */}
      <button
        type="button"
        data-question-collapse
        class="flex w-full flex-row items-center gap-2 px-4 py-2 text-left border-b border-border-weak-base hover:bg-surface-raised-base"
        title="Collapse"
        onClick={() => props.onCollapse()}
      >
        <Icon name="help" class="text-text-weak" />
        <span class="text-13-regular text-text-base">
          {language.t("question.collapsed", { count: questionCount() })}
        </span>
        <Show when={props.asked}>
          <span class="ml-auto text-11-regular text-text-weak tabular-nums">{clock(props.asked!)}</span>
        </Show>
        <div
          data-slot="collapsible-arrow"
          class="flex h-6 w-6 shrink-0 items-center justify-center text-text-weak"
          classList={{ "ml-auto": !props.asked }}
        >
          <Icon name="chevron-grabber-vertical" size="small" />
        </div>
      </button>

      {/* Scroll region: only the question content scrolls when it exceeds the
          panel's capped height. data-scrollable opts into the transcript's
          nested-scroll contract so the session-scroller wheel handlers don't
          hijack this inner scroll. min-h-0 lets it shrink below content height
          inside the flex column. */}
      <div data-scrollable class="flex min-h-0 flex-col gap-2 overflow-y-auto no-scrollbar px-4 py-3 pr-6">
        {/* Request tabs (multiple pending requests) */}
        <Show when={multiRequest()}>
          <div class="flex flex-row flex-wrap gap-1">
            <For each={props.requests}>
              {(r, index) => (
                <button
                  class="px-2 py-0.5 rounded text-11-regular border"
                  classList={{
                    "bg-surface-interactive-base text-text-strong": index() === requestIndex(),
                    "bg-surface-raised-base text-text-weak border-transparent": index() !== requestIndex(),
                  }}
                  style={index() === requestIndex() ? { "border-color": accent() } : undefined}
                  onClick={() => {
                    setRequestIndex(index())
                    resetForRequest()
                  }}
                >
                  {r.questions[0]?.header ?? `Q${index() + 1}`}
                </button>
              )}
            </For>
          </div>
        </Show>

        {/* Question tabs + confirm (multi-question request). Left arrow keys /
            Tab cycle tabs; the active tab gets a full cobalt border (a
            left-only bar looks lopsided on a pill), and the ⇥ hint sits
            top-left. */}
        <Show when={!single()}>
          <div class="flex flex-row flex-wrap items-center gap-1">
            <kbd class="text-11-regular text-text-weak mr-0.5">⇥</kbd>
            <For each={questions()}>
              {(q, index) => (
                <button
                  class="px-2 py-0.5 rounded text-11-regular border"
                  classList={{
                    "bg-surface-interactive-base text-text-strong": index() === store.tab,
                    "bg-surface-raised-base text-text-base border-transparent":
                      index() !== store.tab && (store.answers[index()]?.length ?? 0) > 0,
                    "bg-surface-raised-base text-text-weak border-transparent":
                      index() !== store.tab && (store.answers[index()]?.length ?? 0) === 0,
                  }}
                  style={index() === store.tab ? { "border-color": accent() } : undefined}
                  onClick={() => selectTab(index())}
                >
                  {q.header}
                </button>
              )}
            </For>
            <button
              class="px-2 py-0.5 rounded text-11-regular border"
              classList={{
                "bg-surface-interactive-base text-text-strong": confirm(),
                "bg-surface-raised-base text-text-weak border-transparent": !confirm(),
              }}
              style={confirm() ? { "border-color": accent() } : undefined}
              onClick={() => selectTab(questions().length)}
            >
              Confirm
            </button>
          </div>
        </Show>

        {/* Question + options */}
        <Show when={!confirm()}>
          <div>
            <Markdown class="question-markdown-heading" text={question()?.question ?? ""} complete />
            <Show when={multi()}>
              <span class="text-11-regular text-text-weak"> (select all that apply)</span>
            </Show>
          </div>
          <div class="flex flex-col gap-0.5">
            <For each={options()}>
              {(opt, i) => {
                // Highlight only when the panel is focused — a defocused panel
                // shows no selected/hovered row (nothing looks interactive
                // until you focus).
                const active = () => focused() && i() === store.selected
                const picked = () => store.answers[store.tab]?.includes(opt.label) ?? false
                return (
                  <button
                    class="flex flex-col items-start text-left px-2 py-1 rounded border-l-2 border-transparent transition-colors"
                    classList={{ "bg-surface-interactive-base": active() }}
                    style={active() ? { "border-left-color": accent() } : undefined}
                    onMouseEnter={() => focused() && setStore("selected", i())}
                    onClick={() => activate(i())}
                  >
                    <div class="flex flex-row gap-1.5 text-13-regular w-full">
                      <span
                        class="flex-shrink-0"
                        classList={{ "text-text-weak": !active() }}
                        style={active() ? { color: accent() } : undefined}
                      >
                        {i() + 1}.
                      </span>
                      <span
                        class="flex-1 min-w-0 break-words"
                        classList={{
                          "text-markdown-strong font-bold": active(),
                          "text-success": !active() && picked(),
                          "text-text-base": !active() && !picked(),
                        }}
                      >
                        <Show when={multi()}>{`[${picked() ? "✓" : " "}] `}</Show>
                        <Markdown class="question-markdown-inline" text={opt.label} complete />
                        <Show when={!multi() && picked()}> ✓</Show>
                      </span>
                    </div>
                    <Show when={opt.description}>
                      <div class="pl-4 text-11-regular text-text-weak">
                        <Markdown class="question-markdown" text={opt.description!} complete />
                      </div>
                    </Show>
                  </button>
                )
              }}
            </For>
            <Show when={custom()}>
              <div
                class="flex flex-col items-start px-2 py-1 rounded border-l-2 border-transparent transition-colors"
                classList={{ "bg-surface-interactive-base": other() }}
                style={other() ? { "border-left-color": accent() } : undefined}
              >
                <button
                  class="flex flex-row gap-1.5 text-13-regular text-left"
                  onMouseEnter={() => focused() && setStore("selected", options().length)}
                  onClick={() => activate(options().length)}
                >
                  <span classList={{ "text-text-weak": !other() }} style={other() ? { color: accent() } : undefined}>
                    {options().length + 1}.
                  </span>
                  <span
                    classList={{
                      "text-markdown-strong font-bold": other(),
                      "text-success": !other() && customPicked(),
                      "text-text-base": !other() && !customPicked(),
                    }}
                  >
                    {multi() ? `[${customPicked() ? "✓" : " "}] Type your own answer` : "Type your own answer"}
                  </span>
                </button>
                <Show when={!store.editing && customText()}>
                  <div class="pl-4 text-11-regular text-text-weak">{customText()}</div>
                </Show>
                <Show when={store.editing}>
                  <form
                    class="flex flex-row gap-2 items-end w-full pl-4 pt-1"
                    onSubmit={(e) => {
                      e.preventDefault()
                      submitCustom()
                    }}
                  >
                    <textarea
                      ref={(el) => (input = el)}
                      class="flex-1 min-h-8 rounded border border-border-weak-base bg-background-base px-2 py-1 text-13-regular text-text-base resize-none"
                      placeholder="Type your own answer"
                      value={customText()}
                      rows={1}
                      inputmode={suppressKeyboard() ? "none" : undefined}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault()
                          submitCustom()
                        }
                        if (e.key === "Escape") {
                          setStore("editing", false)
                          panel?.focus()
                        }
                      }}
                    />
                    <Show when={suppressKeyboard()}>
                      <Button
                        type="button"
                        variant="ghost"
                        class="size-6 px-1"
                        onMouseDown={(e: MouseEvent) => {
                          e.preventDefault()
                          requestKeyboard()
                        }}
                        aria-label={language.t("prompt.action.showKeyboard")}
                      >
                        <Icon name="keyboard" class="size-4.5" />
                      </Button>
                    </Show>
                    <DictationPoolButton onInsert={acceptDictation} />
                    <Show when={dictation.supported()}>
                      <Button
                        type="button"
                        variant="ghost"
                        class="size-6 px-1"
                        data-dictation-toggle
                        onClick={() => {
                          if (dictating()) {
                            dictation.stop()
                            setDictating(false)
                            return
                          }
                          setDictating(true)
                          // Keep focus on the textarea so the panel's global
                          // key handler (which yields to editable elements)
                          // stays out of the way and accepted text lands here.
                          input?.focus()
                          dictation.start()
                        }}
                        aria-label={
                          dictating() ? language.t("prompt.action.dictateStop") : language.t("prompt.action.dictate")
                        }
                        aria-pressed={dictating()}
                      >
                        <Icon
                          name="mic"
                          class="size-4.5"
                          classList={{ "text-icon-critical-base animate-pulse": dictating() }}
                        />
                      </Button>
                    </Show>
                    <Button type="submit" variant="primary" size="small">
                      {multi() ? "Add" : "Submit"}
                    </Button>
                  </form>
                  <Show when={dictating()}>
                    <DictationOverlay
                      dictation={dictation}
                      accent={accent()}
                      onAccept={acceptDictation}
                      onStash={stashDictation}
                      onClose={() => setDictating(false)}
                    />
                  </Show>
                </Show>
              </div>
            </Show>
          </div>
        </Show>

        {/* Review (confirm tab) */}
        <Show when={confirm()}>
          <div class="text-13-regular text-text-base">Review</div>
          <For each={questions()}>
            {(q, index) => {
              const value = () => store.answers[index()]?.join(", ") ?? ""
              return (
                <div class="text-13-regular">
                  <span class="text-text-weak">{q.header}: </span>
                  <span classList={{ "text-text-base": !!value(), "text-error": !value() }}>
                    {value() || "(not answered)"}
                  </span>
                </div>
              )
            }}
          </For>
        </Show>
      </div>

      {/* Actions. Each button carries the keyboard shortcut that triggers it,
          shown as a hint above (handled in handleKey: alt+D reject, Escape
          collapse, Enter submit, Tab cycles requests). */}
      <div class="flex shrink-0 flex-row items-end gap-2 justify-end px-4 pb-3">
        <div class="flex flex-col items-center gap-0.5">
          <kbd class="text-11-regular text-text-weak">⌥D</kbd>
          <Button variant="secondary" size="small" onClick={reject}>
            Dismiss
          </Button>
        </div>
        <Show when={confirm() || single()}>
          <div class="flex flex-col items-center gap-0.5">
            <kbd class="text-11-regular text-text-weak">↵</kbd>
            <Button variant="primary" size="small" onClick={single() ? () => activate(store.selected) : submit}>
              Submit
            </Button>
          </div>
        </Show>
        <Show when={multiRequest()}>
          <div class="flex flex-col items-center gap-0.5">
            <kbd class="text-11-regular text-text-weak">⇥</kbd>
            <Button variant="ghost" size="small" onClick={() => cycleRequest(1)}>
              Next question
            </Button>
          </div>
        </Show>
      </div>
    </div>
  )
}
