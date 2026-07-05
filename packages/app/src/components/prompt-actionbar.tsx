import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { Chip, ChipGroup } from "@opencode-ai/ui/chip"
import { useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useQuestion } from "@/context/question"
import { showToast } from "@opencode-ai/ui/toast"

// The prompt action bar, ported from the TUI prompt footer
// (packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx): pending
// (subtasks running), available (results awaiting accept), auto-inject (whether
// completed results inject automatically), and questions (pending count).
// Counts stay live via the background.task.* events the
// TUI also listens to; auto-inject toggles through background.toggleAutoInject.
export function PromptActionBar() {
  const sdk = useSDK()
  const command = useCommand()
  const language = useLanguage()
  const question = useQuestion()
  const params = useParams()

  const [running, setRunning] = createSignal(0)
  const [available, setAvailable] = createSignal(0)
  const [autoInject, setAutoInject] = createSignal(true)

  const questions = createMemo(() => question.total())

  async function refresh() {
    const sessionID = params.id
    if (!sessionID) return
    const [tasks, pending, inject] = await Promise.all([
      sdk.client.background.list({ sessionID }),
      sdk.client.background.getPending({ sessionID }),
      sdk.client.background.getAutoInject({ sessionID }),
    ])
    setRunning((tasks.data ?? []).filter((t) => t.status === "running").length)
    setAvailable((pending.data ?? []).length)
    setAutoInject(inject.data?.autoInject ?? true)
  }

  onMount(() => {
    refresh()

    const unsubs = [
      sdk.event.on("background.task.created", (evt) => {
        if (evt.properties.task.parentSessionID === params.id) setRunning((n) => n + 1)
      }),
      sdk.event.on("background.task.completed", (evt) => {
        if (evt.properties.parentSessionID === params.id) setRunning((n) => Math.max(0, n - 1))
      }),
      sdk.event.on("background.task.result_pending", (evt) => {
        if (evt.properties.sessionID === params.id) setAvailable((n) => n + 1)
      }),
      sdk.event.on("background.task.auto_inject_changed", (evt) => {
        if (evt.properties.sessionID === params.id) setAutoInject(evt.properties.autoInject)
      }),
    ]
    onCleanup(() => unsubs.forEach((u) => u()))
  })

  command.register(() => [
    {
      id: "background.autoinject.toggle",
      title: language.t("command.background.autoinject"),
      description: language.t("command.background.autoinject.description"),
      category: language.t("command.category.session"),
      keybind: "alt+i",
      disabled: !params.id,
      onSelect: async () => {
        const sessionID = params.id
        if (!sessionID) return
        const result = await sdk.client.background.toggleAutoInject({ sessionID })
        const enabled = result.data?.autoInject ?? true
        setAutoInject(enabled)
        showToast({
          title: enabled
            ? language.t("toast.background.autoinject.on.title")
            : language.t("toast.background.autoinject.off.title"),
          variant: enabled ? "success" : "default",
        })
      },
    },
  ])

  const autoinjectTip = createMemo(
    () => `${language.t("actionbar.autoinject.tooltip")} (${command.keybind("background.autoinject.toggle")})`,
  )
  const availableTip = createMemo(
    () => `${language.t("actionbar.available.tooltip")} (${command.keybind("task.pending")})`,
  )
  const questionsTip = createMemo(
    () => `${language.t("actionbar.questions.tooltip")} (${command.keybind("question.list")})`,
  )

  return (
    <div class="flex flex-row flex-wrap items-center gap-1.5">
      <ChipGroup>
        {/* pending: display-only (no onClick), but same weight/color as its
            interactive siblings. */}
        <Chip
          accent={running() > 0 ? "usage-cache-write" : "usage-context-start"}
          tooltip={language.t("actionbar.pending.tooltip")}
        >
          <span class="text-text-base">pending</span> {running()}
        </Chip>

        <Chip
          accent={available() > 0 ? "usage-cache-write" : "usage-context-start"}
          onClick={() => command.trigger("task.pending", "keybind")}
          tooltip={availableTip()}
        >
          <span class="text-text-base">available</span> {available()}
        </Chip>

        <Chip
          accent={autoInject() ? "usage-context-start" : "usage-cache-write"}
          onClick={() => command.trigger("background.autoinject.toggle", "keybind")}
          tooltip={autoinjectTip()}
        >
          <span class="text-text-base">auto-inject</span> {autoInject() ? "on" : "off"}
        </Chip>

        <Show when={questions() > 0}>
          <Chip
            accent="usage-cache-write"
            onClick={() => command.trigger("question.list", "keybind")}
            tooltip={questionsTip()}
          >
            <span class="text-text-base">questions</span> {questions()}
          </Chip>
        </Show>
      </ChipGroup>
    </div>
  )
}
