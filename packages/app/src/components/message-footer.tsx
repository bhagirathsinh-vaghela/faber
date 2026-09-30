import { createMemo, For, Show, type JSX } from "solid-js"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import type { IconName } from "@opencode-ai/ui/icons/provider"
import { opener } from "@opencode-ai/ui/util/question"
import { useSync } from "@/context/sync"
import { useLocal } from "@/context/local"
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
  return `${Math.floor(ms / 86400000)}d ${Math.floor((ms % 86400000) / 3600000)}h`
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
    // A step after a question's answer is timed from the turn's start, as the
    // steps before it are.
    const user = opener(sync.data.message[props.message.sessionID] ?? [], sync.data.part, props.message.parentID)
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

  // Render-only field show/hide: each line-1 field is gated by the
  // active surface's visible set. The canonical-ordered list of visible fields
  // drives the leading-separator logic so a hidden field never orphans a dot —
  // the first visible field has no leading ring, every later one does.
  // `interrupted` is a turn state flag, not a config field, so it stays
  // unconditional (shown only when the turn was aborted).
  const local = useLocal()
  const show = (id: string) => local.dock.isVisible(id)

  const fields = createMemo(() => {
    const result: { id: string; node: () => JSX.Element }[] = []
    if (show("agent"))
      result.push({ id: "agent", node: () => <Field color={AGENT} text={titlecase(props.message.mode)} /> })
    if (show("model") && model())
      result.push({
        id: "model",
        node: () => (
          <span class="inline-flex items-center gap-1">
            <Show when={props.message.providerID}>
              <ProviderIcon id={props.message.providerID as IconName} class="size-3.5 shrink-0 text-text-weak" />
            </Show>
            <Field color={MODEL} text={model()} />
          </span>
        ),
      })
    if (show("variant") && props.message.variant)
      result.push({ id: "variant", node: () => <Field color={VARIANT} text={props.message.variant!} /> })
    if (show("duration") && elapsed())
      result.push({ id: "duration", node: () => <Field color={DURATION} text={elapsed()!} /> })
    if (interrupted()) result.push({ id: "interrupted", node: () => <Field color={INTERRUPTED} text="interrupted" /> })
    if (show("cwd") && dir()) result.push({ id: "cwd", node: () => <Field color={CWD} text={dir()} /> })
    return result
  })

  return (
    <>
      <div class="flex flex-row flex-wrap items-center text-11-regular font-mono leading-tight">
        <For each={fields()}>
          {(field, i) => (
            <>
              <Show when={i() > 0}>
                <Dot />
              </Show>
              {field.node()}
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
