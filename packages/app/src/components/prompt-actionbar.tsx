import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import { Chip, ChipGroup } from "@opencode-ai/ui/chip"
import { useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useQuestion } from "@/context/question"
import { useLocal } from "@/context/local"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogMcpCorpus } from "@/components/dialog-mcp-corpus"

// The prompt action bar: subagents still running, pending questions, and the
// MCP view. The running count is read from the server's subagent list, and
// re-read whenever the session's descendant-busy edge flips, which is when a
// subagent's turn starts or ends.
export function PromptActionBar() {
  const sdk = useSDK()
  const sync = useSync()
  const command = useCommand()
  const language = useLanguage()
  const question = useQuestion()
  const local = useLocal()
  const params = useParams()
  const dialog = useDialog()

  // MCP is always on. The chip opens a read-only view of the tools the model
  // sees for this session's instance (post-`disabled`, at each server's tier).
  // Server management is config-file + `opencode mcp auth`, not UI.
  const viewMcp = () => dialog.show(() => <DialogMcpCorpus />)

  const [running, setRunning] = createSignal(0)
  const questions = createMemo(() => question.total())
  const busy = () => sync.data.session_busy[params.id ?? ""]

  // Only the newest request may write, so overlapping refetches cannot land
  // out of order.
  let seq = 0
  const refresh = async (sessionID: string | undefined) => {
    if (!sessionID) return setRunning(0)
    const mine = ++seq
    const list = await sdk.client.background.list({ sessionID }).catch(() => undefined)
    if (mine !== seq || params.id !== sessionID) return
    setRunning((list?.data ?? []).filter((s) => s.status === "running").length)
  }

  // A subagent stops counting when its result is delivered, which lands just
  // after its turn ends and wakes this session. Both edges refetch, and a slow
  // tick while any are running covers a result held back by a job.
  createEffect(on([() => params.id, () => busy()?.busyDescendant, () => busy()?.busySelf], ([id]) => refresh(id)))
  const tick = setInterval(() => running() > 0 && void refresh(params.id), 10_000)
  onCleanup(() => clearInterval(tick))

  const questionsTip = createMemo(
    () => `${language.t("actionbar.questions.tooltip")} (${command.keybind("question.list")})`,
  )

  return (
    // Mobile: display:contents so this component's ChipGroup is a direct child
    // of the dock chip row and spreads with the usage chips (no left/right
    // split). Desktop keeps its own flex wrapper.
    <div class="contents dock-wide:flex dock-wide:flex-row dock-wide:flex-wrap dock-wide:items-center dock-wide:gap-1.5">
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

        <Show when={questions() > 0}>
          <Chip
            accent="usage-cache-write"
            onClick={() => command.trigger("question.list", "keybind")}
            tooltip={questionsTip()}
          >
            <span class="text-text-base">questions</span> {questions()}
          </Chip>
        </Show>

        {/* Rightmost because it is session-level state; the chips before it are
            per-turn activity. */}
        <Show when={local.dock.isVisible("mcp")}>
          <Chip onClick={viewMcp} tooltip={language.t("mcp.chip.view")}>
            <span class="text-text-base">MCP</span>
          </Chip>
        </Show>
      </ChipGroup>
    </div>
  )
}
