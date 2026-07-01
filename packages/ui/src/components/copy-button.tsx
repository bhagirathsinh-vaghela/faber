import { createSignal, Show } from "solid-js"
import { copyText } from "../util/clipboard"
import { useI18n } from "../context/i18n"
import { Tooltip } from "./tooltip"
import { IconButton } from "./icon-button"

// Shared box-corner copy button. Lives in a box's title bar (top-right) and
// copies that box's content. `content` returns the text to copy; the button is
// omitted when it returns empty, so a box with nothing to copy shows nothing.
export function CopyButton(props: { content: () => string; class?: string }) {
  const i18n = useI18n()
  const [copied, setCopied] = createSignal(false)

  const copy = async (e: MouseEvent) => {
    e.stopPropagation()
    const text = props.content()
    if (!text) return
    await copyText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Show when={props.content()}>
      <div data-slot="box-copy" class={props.class}>
        <Tooltip value={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")} placement="top" gutter={8}>
          <IconButton
            icon={copied() ? "check" : "copy"}
            variant="secondary"
            onMouseDown={(e) => e.preventDefault()}
            onClick={copy}
            aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")}
          />
        </Tooltip>
      </div>
    </Show>
  )
}
