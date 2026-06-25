import { createMemo, For, Show } from "solid-js"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { useSync } from "@/context/sync"

// Mirrors the TUI ModelHeader: agent · model · provider · variant [· duration]
// [· interrupted] [· directory]. MODEL_COLOR matches the TUI (#E83CF5).
const MUTED = "var(--color-text-weak)"
const MODEL = "#E83CF5"
const WARNING = "#DBA92E"
const PRIMARY = "var(--color-text-base)"

function titlecase(str: string): string {
  return str.replace(/\b\w/g, (c) => c.toUpperCase())
}

function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`
  return `${Math.floor((ms % 3600000) / 86400000)}d ${Math.floor(ms / 3600000)}h`
}

function Segment(props: { color: string; text: string }) {
  return (
    <span>
      <span style={{ color: MUTED }}> · </span>
      <span class="font-semibold" style={{ color: props.color }}>
        {props.text}
      </span>
    </span>
  )
}

export function MessageFooter(props: { message: AssistantMessage }) {
  const sync = useSync()

  const model = createMemo(() => {
    const provider = sync.data.provider.all.find((p) => p.id === props.message.providerID)
    return {
      provider: provider?.name ?? props.message.providerID,
      model: provider?.models[props.message.modelID]?.name ?? props.message.modelID,
    }
  })

  const elapsed = createMemo(() => {
    const completed = props.message.time.completed
    if (!completed) return null
    const user = sync.data.message[props.message.sessionID]?.find(
      (m) => m.role === "user" && m.id === props.message.parentID,
    )
    if (!user) return null
    return duration(completed - user.time.created)
  })

  const dir = createMemo(() => {
    const home = sync.data.path.home
    const cwd = props.message.path.cwd
    return home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd
  })

  const interrupted = createMemo(() => props.message.error?.name === "MessageAbortedError")

  const tail = createMemo(() => {
    const result: { color: string; text: string }[] = []
    if (props.message.variant) result.push({ color: WARNING, text: props.message.variant })
    if (elapsed()) result.push({ color: MUTED, text: elapsed()! })
    if (interrupted()) result.push({ color: MUTED, text: "interrupted" })
    if (dir()) result.push({ color: PRIMARY, text: dir() })
    return result
  })

  return (
    <div class="flex flex-row flex-wrap items-center pt-1 text-11-regular font-mono leading-tight">
      <span class="font-semibold" style={{ color: "var(--color-text-base)" }}>
        {titlecase(props.message.mode)}
      </span>
      <Show when={model().model}>
        <Segment color={MODEL} text={model().model} />
      </Show>
      <Show when={model().provider}>
        <Segment color={MUTED} text={model().provider} />
      </Show>
      <For each={tail()}>{(p) => <Segment color={p.color} text={p.text} />}</For>
    </div>
  )
}
