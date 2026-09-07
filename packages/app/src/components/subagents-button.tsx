import { IconButton } from "@opencode-ai/ui/icon-button"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"

// Sibling of JobsButton, rendered in the session header (subagents are
// session-scoped). Opens the subagent switcher rather than the jobs list.
export function SubagentsButton(props: { class?: string }) {
  const command = useCommand()
  const language = useLanguage()

  return (
    <IconButton
      icon="subagents"
      iconSize="medium"
      variant="ghost"
      class={`shrink-0 p-0 ${props.class ?? ""}`}
      onClick={() => command.trigger("subagent.list")}
      aria-label={language.t("command.subagent.list")}
    />
  )
}
