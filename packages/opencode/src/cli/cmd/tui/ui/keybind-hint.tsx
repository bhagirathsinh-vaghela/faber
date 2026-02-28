import { Show } from "solid-js"
import { useTheme } from "../context/theme"

export function KeybindHint(props: { text: string; visible: boolean }) {
  const { theme } = useTheme()

  return (
    <Show when={props.visible}>
      <box position="absolute" right={2} top={0} zIndex={1000}>
        <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2} backgroundColor={theme.backgroundPanel}>
          <text fg={theme.text}>{props.text}</text>
        </box>
      </box>
    </Show>
  )
}
