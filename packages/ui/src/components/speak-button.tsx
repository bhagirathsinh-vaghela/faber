import { Show } from "solid-js"
import { useI18n } from "../context/i18n"
import { useData, type SpeakTarget } from "../context/data"
import { Tooltip } from "./tooltip"
import { IconButton } from "./icon-button"

// Box-corner button that reads a text part aloud. Sits beside CopyButton and
// shares its shape. Absent unless the host supplied a speak handler and the
// part is ready to be read, so there is never a dead control.
export function SpeakButton(props: { content: () => SpeakTarget | undefined; class?: string }) {
  const i18n = useI18n()
  const host = useData()

  const speak = (e: MouseEvent) => {
    e.stopPropagation()
    const target = props.content()
    if (!target?.text) return
    host.speakText?.(target.key, target.text)
  }

  return (
    <Show when={host.speakText && props.content()?.text}>
      {/* data-speaking keeps the button on screen while THIS part is being
          read: the hover reveal would otherwise take it away the moment the
          pointer left the box, mid-reading. */}
      <div
        data-slot="box-speak"
        data-speaking={host.speaking?.(props.content()?.key ?? "") || undefined}
        class={props.class}
      >
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
