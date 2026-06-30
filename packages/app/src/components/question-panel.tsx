import { createStore } from "solid-js/store"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import type { QuestionRequest } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useQuestion } from "@/context/question"

// Pinned question prompt. Mirrors the TUI QuestionPrompt
// (packages/opencode/src/cli/cmd/tui/routes/session/question.tsx): tabbed
// multi-question/multi-request flow, single-question fast path, custom answers,
// multi-select, review/confirm, and a countdown bar that auto-defers on timeout.
//
// Deferred-question state (pending ∪ deferred list, visibility) lives in the
// shared question context so the prompt action bar's count sees deferred ones
// too; question_list (alt+y) toggles visibility to bring a deferred one back.
export function QuestionPanel() {
  const command = useCommand()
  const language = useLanguage()
  const question = useQuestion()

  createEffect(
    on(
      () => question.pending().length,
      (len, prev) => {
        if (len > 0 && !prev) question.show()
      },
    ),
  )
  createEffect(() => {
    if (question.count === 0 && question.visible()) question.toggle()
  })

  command.register(() => [
    {
      id: "question.list",
      title: language.t("command.question.list"),
      description: language.t("command.question.list.description"),
      category: language.t("command.category.session"),
      keybind: "alt+y",
      disabled: question.count === 0,
      onSelect: () => question.toggle(),
    },
  ])

  return (
    <Show when={question.count > 0 && question.visible()}>
      <Panel
        requests={question.requests()}
        pendingIDs={question.pendingIDs()}
        onHide={question.hide}
        onAnswered={question.answered}
        onDismissed={question.drop}
      />
    </Show>
  )
}

function Panel(props: {
  requests: QuestionRequest[]
  pendingIDs: Set<string>
  onHide: (reqs: QuestionRequest[]) => void
  onAnswered: (id: string, answers: string[][], questions: QuestionRequest["questions"]) => void
  onDismissed: (id: string) => void
}) {
  const sdk = useSDK()
  const sync = useSync()
  const command = useCommand()

  const [requestIndex, setRequestIndex] = createSignal(0)
  const request = createMemo(() => props.requests[requestIndex()] ?? props.requests[0])
  const multiRequest = createMemo(() => props.requests.length > 1)

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

  const question = createMemo(() => questions()[store.tab])
  const confirm = createMemo(() => !single() && store.tab === questions().length)
  const options = createMemo(() => question()?.options ?? [])
  const custom = createMemo(() => question()?.custom !== false)
  const other = createMemo(() => custom() && store.selected === options().length)
  const customText = createMemo(() => store.custom[store.tab] ?? "")
  const multi = createMemo(() => question()?.multiple === true)
  const customPicked = createMemo(() => {
    const value = customText()
    if (!value) return false
    return store.answers[store.tab]?.includes(value) ?? false
  })

  const isPending = (id: string) => props.pendingIDs.has(id)

  const TIMEOUT = (sync.data.config as any)?.tui?.question_timeout ?? 120
  const [remaining, setRemaining] = createSignal(TIMEOUT)
  const timerActive = createMemo(() => {
    if (TIMEOUT === 0) return false
    const r = request()
    return Boolean(r && isPending(r.id))
  })

  createEffect(
    on(
      () => request()?.id,
      (id) => {
        if (id && isPending(id)) setRemaining(TIMEOUT)
      },
    ),
  )

  createEffect(() => {
    if (!timerActive()) return
    const handle = setInterval(() => {
      setRemaining((prev) => {
        const next = prev - 1
        if (next <= 0) {
          defer()
          return 0
        }
        return next
      })
    }, 1000)
    onCleanup(() => clearInterval(handle))
  })

  // Color maps continuously to time left: hue sweeps green (120°) -> amber ->
  // red (0°) in lockstep with the remaining fraction. No thresholds, no floor —
  // one smooth glide from full green at the start to pure red at expiry.
  const fraction = createMemo(() => (TIMEOUT > 0 ? Math.max(0, Math.min(1, remaining() / TIMEOUT)) : 1))
  const barColor = createMemo(() => `hsl(${Math.round(120 * fraction())}, 85%, 55%)`)
  const mmss = createMemo(() => {
    const total = Math.max(0, remaining())
    const m = Math.floor(total / 60)
    const s = total % 60
    return m > 0 ? `${m}:${s.toString().padStart(2, "0")}` : `${s}s`
  })

  function resetForRequest() {
    setStore({ tab: 0, answers: [], custom: [], selected: 0, editing: false })
  }

  function submit() {
    const r = request()
    if (!r) return
    const answers = questions().map((_, i) => store.answers[i] ?? [])
    if (isPending(r.id)) sdk.client.question.reply({ requestID: r.id, answers })
    props.onAnswered(r.id, answers, r.questions)
  }

  function reject() {
    const r = request()
    if (!r) return
    if (isPending(r.id)) sdk.client.question.reject({ requestID: r.id })
    props.onDismissed(r.id)
  }

  function defer() {
    for (const r of props.requests) {
      if (isPending(r.id)) sdk.client.question.defer({ requestID: r.id })
    }
    props.onHide(props.requests)
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
      props.onAnswered(r.id, [[answer]], r.questions)
      return
    }
    setStore("tab", store.tab + 1)
    setStore("selected", 0)
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
      return
    }
    if (multi()) {
      const inputs = [...store.custom]
      inputs[store.tab] = text
      setStore("custom", inputs)
      if (!(store.answers[store.tab] ?? []).includes(text)) toggle(text)
      setStore("editing", false)
      return
    }
    pick(text, true)
    setStore("editing", false)
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

  // A pending question owns all input. The capture-phase keydown handler runs
  // before any focused element (prompt contenteditable included) sees the key,
  // and both preventDefault + stopPropagation so the prompt's own handler never
  // fires — the question is answered before anything else can be typed. The
  // global command keymap is suspended for the panel's lifetime too. The
  // custom-answer textarea is the one exception: it keeps its own Enter/Escape
  // handling, so yield while it has focus.
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
      case "Enter":
        stop()
        if (confirm()) submit()
        else activate(store.selected)
        return
      case "Escape":
        stop()
        defer()
        return
    }
  }

  onMount(() => {
    command.keybinds(false)
    // Pull focus off the prompt so the question is the clearly-active surface
    // and the caret stops blinking in the input behind it.
    ;(document.activeElement as HTMLElement | null)?.blur()
    panel?.focus()
    document.addEventListener("keydown", handleKey, true)
    onCleanup(() => {
      command.keybinds(true)
      document.removeEventListener("keydown", handleKey, true)
    })
  })

  return (
    <div
      ref={(el) => (panel = el)}
      tabindex={-1}
      class="relative mb-3 rounded-md border-2 border-primary bg-background-base/95 shadow-md outline-none"
      data-component="question-panel"
    >
      {/* Circular countdown ring, straddling the top-right corner. Faint full
          track + colored arc that depletes clockwise from 12 o'clock (circle
          rotated -90° so the dash starts at top). pathLength=100 makes the dash
          math size-independent. Seconds number sits inside. */}
      <Show when={timerActive()}>
        <div class="absolute -right-3 -top-3 z-20 h-12 w-12">
          <svg class="h-full w-full -rotate-90" viewBox="0 0 36 36">
            <circle
              cx="18"
              cy="18"
              r="16"
              fill="var(--color-background-base)"
              stroke="var(--color-border-weak-base)"
              stroke-width="3"
            />
            <circle
              cx="18"
              cy="18"
              r="16"
              fill="none"
              stroke={barColor()}
              stroke-width="3"
              stroke-linecap="round"
              pathLength="100"
              stroke-dasharray="100"
              stroke-dashoffset={100 * (1 - fraction())}
              style={{ transition: "stroke-dashoffset 1s linear, stroke 0.5s linear" }}
            />
          </svg>
          <div
            class="absolute inset-0 flex items-center justify-center text-11-regular font-semibold [font-variant-numeric:tabular-nums]"
            style={{ color: barColor() }}
          >
            {mmss()}
          </div>
        </div>
      </Show>

      <div class="flex flex-col gap-2 px-4 py-3 pr-6">
        {/* Request tabs (multiple pending requests) */}
        <Show when={multiRequest()}>
          <div class="flex flex-row flex-wrap gap-1">
            <For each={props.requests}>
              {(r, index) => (
                <button
                  class="px-2 py-0.5 rounded text-11-regular"
                  classList={{
                    "bg-primary text-background-base": index() === requestIndex(),
                    "bg-background-element text-text-weak": index() !== requestIndex(),
                  }}
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

        {/* Question tabs + confirm (multi-question request) */}
        <Show when={!single()}>
          <div class="flex flex-row flex-wrap gap-1">
            <For each={questions()}>
              {(q, index) => (
                <button
                  class="px-2 py-0.5 rounded text-11-regular"
                  classList={{
                    "bg-primary text-background-base": index() === store.tab,
                    "bg-background-element text-text-base":
                      index() !== store.tab && (store.answers[index()]?.length ?? 0) > 0,
                    "bg-background-element text-text-weak":
                      index() !== store.tab && (store.answers[index()]?.length ?? 0) === 0,
                  }}
                  onClick={() => selectTab(index())}
                >
                  {q.header}
                </button>
              )}
            </For>
            <button
              class="px-2 py-0.5 rounded text-11-regular"
              classList={{
                "bg-primary text-background-base": confirm(),
                "bg-background-element text-text-weak": !confirm(),
              }}
              onClick={() => selectTab(questions().length)}
            >
              Confirm
            </button>
          </div>
        </Show>

        {/* Question + options */}
        <Show when={!confirm()}>
          <div class="text-13-regular text-text-base">
            {question()?.question}
            {multi() ? " (select all that apply)" : ""}
          </div>
          <div class="flex flex-col gap-0.5">
            <For each={options()}>
              {(opt, i) => {
                const active = () => i() === store.selected
                const picked = () => store.answers[store.tab]?.includes(opt.label) ?? false
                return (
                  <button
                    class="flex flex-col items-start text-left px-2 py-1 rounded"
                    classList={{ "bg-background-element": active() }}
                    onMouseEnter={() => setStore("selected", i())}
                    onClick={() => activate(i())}
                  >
                    <div class="flex flex-row gap-1.5 text-13-regular">
                      <span class="text-text-weak">{i() + 1}.</span>
                      <span
                        classList={{
                          "text-secondary": active(),
                          "text-success": !active() && picked(),
                          "text-text-base": !active() && !picked(),
                        }}
                      >
                        {multi() ? `[${picked() ? "✓" : " "}] ${opt.label}` : opt.label}
                        {!multi() && picked() ? " ✓" : ""}
                      </span>
                    </div>
                    <Show when={opt.description}>
                      <div class="pl-4 text-11-regular text-text-weak">{opt.description}</div>
                    </Show>
                  </button>
                )
              }}
            </For>
            <Show when={custom()}>
              <div class="flex flex-col items-start px-2 py-1 rounded" classList={{ "bg-background-element": other() }}>
                <button
                  class="flex flex-row gap-1.5 text-13-regular text-left"
                  onMouseEnter={() => setStore("selected", options().length)}
                  onClick={() => activate(options().length)}
                >
                  <span class="text-text-weak">{options().length + 1}.</span>
                  <span
                    classList={{
                      "text-secondary": other(),
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
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault()
                          submitCustom()
                        }
                        if (e.key === "Escape") setStore("editing", false)
                      }}
                    />
                    <Button type="submit" variant="primary" size="small">
                      {multi() ? "Add" : "Submit"}
                    </Button>
                  </form>
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

      {/* Actions */}
      <div class="flex flex-row gap-2 justify-end px-4 pb-3">
        <Button variant="ghost" size="small" onClick={reject}>
          Dismiss
        </Button>
        <Button variant="secondary" size="small" onClick={defer}>
          Defer
        </Button>
        <Show when={confirm() || single()}>
          <Button variant="primary" size="small" onClick={single() ? () => activate(store.selected) : submit}>
            Submit
          </Button>
        </Show>
        <Show when={multiRequest()}>
          <Button variant="ghost" size="small" onClick={() => cycleRequest(1)}>
            Next question
          </Button>
        </Show>
      </div>
    </div>
  )
}
