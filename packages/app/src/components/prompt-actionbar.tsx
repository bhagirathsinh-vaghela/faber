import { createMemo, Show } from "solid-js"
import { Chip, ChipGroup } from "@opencode-ai/ui/chip"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useQuestion } from "@/context/question"
import { useLocal } from "@/context/local"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogMcpCorpus } from "@/components/dialog-mcp-corpus"

// The prompt action bar: pending questions, and the MCP view.
export function PromptActionBar() {
  const command = useCommand()
  const language = useLanguage()
  const question = useQuestion()
  const local = useLocal()
  const dialog = useDialog()

  // MCP is always on. The chip opens a read-only view of the tools the model
  // sees for this session's instance (post-`disabled`, at each server's tier).
  // Server management is config-file + `opencode mcp auth`, not UI.
  const viewMcp = () => dialog.show(() => <DialogMcpCorpus />)

  const questions = createMemo(() => question.total())

  const questionsTip = createMemo(
    () => `${language.t("actionbar.questions.tooltip")} (${command.keybind("question.list")})`,
  )

  return (
    // Mobile: display:contents so this component's ChipGroup is a direct child
    // of the dock chip row and spreads with the usage chips (no left/right
    // split). Desktop keeps its own flex wrapper.
    <div class="contents dock-wide:flex dock-wide:flex-row dock-wide:flex-wrap dock-wide:items-center dock-wide:gap-1.5">
      <ChipGroup>
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
