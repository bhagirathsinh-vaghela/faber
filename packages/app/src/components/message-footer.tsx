import { createMemo, For, Show } from "solid-js"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import type { IconName } from "@opencode-ai/ui/icons/provider"
import { useSync } from "@/context/sync"
import { UsageLine, statsFromMessage } from "@/components/usage-line"

// Status line: agent · [provider-icon] model · variant [· duration]
// [· interrupted] · cwd. Field order matches the dock picker row (icon precedes
// model). This is a monospace line, so each segment is colored by its semantic
// "token type" from the editor's own syntax palette (auto-tracks every theme):
// agent=type, model=the model accent, variant=constant, duration=primitive
// (number), cwd=string (path), interrupted=critical. Raw --<token> (not the
// --color-* alias) because the aliases tree-shake out when only referenced inline.
const AGENT = "var(--syntax-type)"
const MODEL = "var(--model)"
const VARIANT = "var(--syntax-constant)"
const DURATION = "var(--syntax-primitive)"
const CWD = "var(--syntax-string)"
const INTERRUPTED = "var(--syntax-critical)"
const SEPARATOR = "var(--text-weaker)"

function titlecase(str: string): string {
  return str.replace(/\b\w/g, (c) => c.toUpperCase())
}

// Separator: a small CSS-drawn hollow ring (crisp + consistent across fonts,
// unlike a · or ◦ glyph). Dim, baseline-centered, sits in the gap between fields.
function Dot() {
  return (
    <span class="mx-2 inline-block size-[4px] rounded-full border align-middle" style={{ "border-color": SEPARATOR }} />
  )
}

function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`
  return `${Math.floor((ms % 3600000) / 86400000)}d ${Math.floor(ms / 3600000)}h`
}

function Field(props: { color: string; text: string }) {
  return (
    <span class="font-medium" style={{ color: props.color }}>
      {props.text}
    </span>
  )
}

export function MessageFooter(props: { message: AssistantMessage }) {
  const sync = useSync()

  const model = createMemo(() => {
    const provider = sync.data.provider.all.find((p) => p.id === props.message.providerID)
    return provider?.models[props.message.modelID]?.name ?? props.message.modelID
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

  const stats = createMemo(() => statsFromMessage(props.message, sync.data.provider.all))

  const tail = createMemo(() => {
    const result: { color: string; text: string }[] = []
    if (props.message.variant) result.push({ color: VARIANT, text: props.message.variant })
    if (elapsed()) result.push({ color: DURATION, text: elapsed()! })
    if (interrupted()) result.push({ color: INTERRUPTED, text: "interrupted" })
    if (dir()) result.push({ color: CWD, text: dir() })
    return result
  })

  return (
    <>
      <div class="flex flex-row flex-wrap items-center pt-1 text-11-regular font-mono leading-tight">
        <Field color={AGENT} text={titlecase(props.message.mode)} />
        <Show when={model()}>
          <Dot />
          <span class="inline-flex items-center gap-1">
            <Show when={props.message.providerID}>
              <ProviderIcon
                id={props.message.providerID as IconName}
                class="size-3.5 shrink-0 text-text-weak"
              />
            </Show>
            <Field color={MODEL} text={model()} />
          </span>
        </Show>
        <For each={tail()}>
          {(field) => (
            <>
              <Dot />
              <Field color={field.color} text={field.text} />
            </>
          )}
        </For>
      </div>
      <Show when={stats()}>
        {(s) => (
          <UsageLine
            stats={s()}
            totals={props.message.sessionTotal ?? { input: 0, output: 0, cacheWrite: 0 }}
            cost={props.message.sessionTotal?.cost ?? 0}
          />
        )}
      </Show>
    </>
  )
}
