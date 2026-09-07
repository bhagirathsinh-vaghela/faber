import { IconButton } from "@opencode-ai/ui/icon-button"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"

// Sits beside Stop, in two mutually exclusive placements: the session header
// inside a session, the titlebar everywhere else.
export function JobsButton(props: { class?: string }) {
  const command = useCommand()
  const language = useLanguage()

  return (
    <IconButton
      icon="queue-list"
      iconSize="medium"
      variant="ghost"
      class={`shrink-0 p-0 ${props.class ?? ""}`}
      onClick={() => command.trigger("jobs.open")}
      aria-label={language.t("common.jobs")}
    />
  )
}
