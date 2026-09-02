import { Icon } from "@opencode-ai/ui/icon"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"

// Sits beside Stop, in two mutually exclusive placements: the session header
// inside a session, the titlebar everywhere else.
//
// Drawn from the icon set rather than as an emoji, so it inherits the control
// sizing and the theme's colour like every other button on the row.
export function JobsButton(props: { class?: string }) {
  const command = useCommand()
  const language = useLanguage()

  return (
    <button
      type="button"
      class={`flex items-center justify-center shrink-0 rounded-md leading-none hover:bg-surface-raised-base-hover size-(--control-height) text-(length:--control-icon) ${props.class ?? ""}`}
      onClick={() => command.trigger("jobs.open")}
      aria-label={language.t("common.jobs")}
    >
      <Icon name="queue-list" size="medium" aria-hidden="true" />
    </button>
  )
}
