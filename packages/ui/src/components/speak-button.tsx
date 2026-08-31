import { Show } from "solid-js"
import { useI18n } from "../context/i18n"
import { useData } from "../context/data"
import { Tooltip } from "./tooltip"
import { IconButton } from "./icon-button"

// Box-corner button that reads a block of assistant prose aloud. Sits beside
// CopyButton and shares its shape. Absent unless the host supplied a speak
// handler, so a client with no speech support shows no dead control.
export function SpeakButton(props: { content: () => string; class?: string }) {
  const i18n = useI18n()
  const host = useData()

  const speak = (e: MouseEvent) => {
    e.stopPropagation()
    const text = props.content()
    if (!text) return
    host.speakText?.(text)
  }

  return (
    <Show when={host.speakText && props.content()}>
      <div data-slot="box-speak" class={props.class}>
        <Tooltip value={i18n.t("ui.message.speak")} placement="top" gutter={8}>
          <IconButton
            icon="speaker"
            variant="secondary"
            onMouseDown={(e) => e.preventDefault()}
            onClick={speak}
            aria-label={i18n.t("ui.message.speak")}
          />
        </Tooltip>
      </div>
    </Show>
  )
}
