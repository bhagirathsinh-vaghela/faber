import { Icon } from "@opencode-ai/ui/icon"
import { useLocalOptional } from "@/context/local"
import { agentColor } from "@/utils/agent"

// Every mic in the app paints the same three states, and they were drifting as
// three copies: the composer's, the question panel's, and the reader pill's.
//
// The tint is the session agent's color and marks WHICH mic a dictation would
// land on, so it answers the question a second visible mic raises. Capturing
// overrides it in critical red, since a live microphone outranks whose turn it
// is. A mic that is neither is the plain icon.
//
// Local is optional: outside a session's LocalProvider there is no agent to
// tint by, so it falls back to the plain interactive color.
export function MicIcon(props: { targeted?: boolean; running?: boolean; filled?: boolean; class?: string }) {
  const local = useLocalOptional()
  const tint = () => {
    const agent = local?.agent.current()
    return (agent && agentColor(agent.name, agent.color)) ?? "var(--icon-interactive-base)"
  }
  return (
    <Icon
      name={props.filled ? "mic-filled" : "mic"}
      class={props.class}
      classList={{ "text-icon-critical-base animate-pulse": !!props.running }}
      style={props.running || !props.targeted ? undefined : { color: tint() }}
    />
  )
}
