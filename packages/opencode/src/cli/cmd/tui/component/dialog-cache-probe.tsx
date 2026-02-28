import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"
import { onMount } from "solid-js"
import { useKeyboard } from "@opentui/solid"

export type DialogCacheProbeProps = {
  hint: string
  onConfirm: (value: number) => void
  onDelete: () => void
}

export function DialogCacheProbe(props: DialogCacheProbeProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  let textarea: TextareaRenderable

  function submit() {
    const text = textarea.plainText.trim()
    const idx = parseInt(text, 10)
    if (isNaN(idx) || idx < 0) return
    props.onConfirm(idx)
    dialog.clear()
  }

  useKeyboard((evt) => {
    if (evt.name === "return") {
      submit()
      return
    }
    if (evt.name === "d") {
      evt.preventDefault()
      props.onDelete()
      dialog.clear()
      return
    }
    // Only allow digits, backspace, delete, and arrow keys in the input
    if (evt.name.length === 1 && !/[0-9]/.test(evt.name)) {
      evt.preventDefault()
    }
  })

  onMount(() => {
    dialog.setSize("medium")
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return
      textarea.focus()
    }, 1)
    textarea.gotoLineEnd()
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Cache probe block #
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>
      <box gap={1}>
        <textarea
          onSubmit={submit}
          height={3}
          keyBindings={[{ name: "return", action: "submit" }]}
          ref={(val: TextareaRenderable) => (textarea = val)}
          placeholder={props.hint || "e.g. 40"}
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.text}
        />
      </box>
      <box paddingBottom={1} gap={2} flexDirection="row">
        <text fg={theme.text}>
          enter <span style={{ fg: theme.textMuted }}>set probe</span>
        </text>
        <text fg={theme.text}>
          d <span style={{ fg: theme.textMuted }}>clear probe</span>
        </text>
      </box>
    </box>
  )
}
