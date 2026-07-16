import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { Chip, ChipGroup } from "@opencode-ai/ui/chip"
import { useParams, useSearchParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useQuestion } from "@/context/question"
import { useLocal } from "@/context/local"
import { showToast } from "@opencode-ai/ui/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogEnableMcp } from "@/components/dialog-enable-mcp"

// The prompt action bar, ported from the TUI prompt footer
// (packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx): pending
// (subtasks running), available (results awaiting accept), auto-inject (whether
// completed results inject automatically), and questions (pending count).
// Counts stay live via the background.task.* events the
// TUI also listens to; auto-inject toggles through background.toggleAutoInject.
export function PromptActionBar() {
  const sdk = useSDK()
  const sync = useSync()
  const command = useCommand()
  const language = useLanguage()
  const question = useQuestion()
  const local = useLocal()
  const params = useParams()
  const [searchParams] = useSearchParams()
  const dialog = useDialog()

  // MCP on/off is a per-session latch. A session shows enabled once mcpEnabled
  // is true; a brand-new session (no id yet) reached via the "+MCP" entry point
  // carries ?mcp=1, which prompt-input commits to mcpEnabled on the first turn —
  // treat that as "armed" so the chip reads on before the session exists.
  const mcpEnabled = createMemo(() => (params.id ? sync.session.get(params.id)?.mcpEnabled === true : false))
  const mcpArmed = createMemo(() => !params.id && !!searchParams.mcp)
  const mcpOn = createMemo(() => mcpEnabled() || mcpArmed())

  const enableMcp = () => {
    const id = params.id
    if (!id || mcpEnabled()) return
    dialog.show(() => (
      <DialogEnableMcp
        onConfirm={async () => {
          await sdk.client.session.update({ sessionID: id, mcpEnabled: true })
        }}
      />
    ))
  }

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
        <Show when={local.dock.isVisible("pending")}>
          <Chip
            accent={running() > 0 ? "usage-cache-write" : "usage-context-start"}
            tooltip={language.t("actionbar.pending.tooltip")}
          >
            <span class="text-text-base">pending</span> {running()}
          </Chip>
        </Show>

        <Show when={local.dock.isVisible("available")}>
          <Chip
            accent={available() > 0 ? "usage-cache-write" : "usage-context-start"}
            onClick={() => command.trigger("task.pending", "keybind")}
            tooltip={availableTip()}
          >
            <span class="text-text-base">available</span> {available()}
          </Chip>
        </Show>

        <Show when={local.dock.isVisible("auto-inject")}>
          <Chip
            accent={autoInject() ? "usage-context-start" : "usage-cache-write"}
            onClick={() => command.trigger("background.autoinject.toggle", "keybind")}
            tooltip={autoinjectTip()}
          >
            <span class="text-text-base">auto-inject</span> {autoInject() ? "on" : "off"}
          </Chip>
        </Show>

        <Show when={questions() > 0}>
          <Chip
            accent="usage-cache-write"
            onClick={() => command.trigger("question.list", "keybind")}
            tooltip={questionsTip()}
          >
            <span class="text-text-base">questions</span> {questions()}
          </Chip>
        </Show>

        {/* MCP on/off latch, kept rightmost as the session-level state (the
            others are per-turn activity). On (enabled or armed) fills the chip
            green; off is muted text and, on an existing session, clicks to
            enable (one-way). No count — enablement is a boolean; server detail
            lives on the MCP settings page. */}
        <Chip
          filled={mcpOn()}
          accent={mcpOn() ? "box-accent-assistant" : undefined}
          onClick={mcpEnabled() || !params.id ? undefined : enableMcp}
          tooltip={mcpOn() ? language.t("mcp.chip.enabled") : language.t("mcp.chip.enable")}
        >
          <span classList={{ "text-text-weaker": !mcpOn() }}>MCP</span>
        </Chip>
      </ChipGroup>
    </div>
  )
}
