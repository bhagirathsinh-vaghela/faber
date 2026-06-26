import { Show, type JSX } from "solid-js"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"

type ProviderLike = { id: string; models: Record<string, { limit?: { context?: number } }> }

export const GREEN = "#22DD22"
export const NEXT_TURN_ORANGE = "#DB6A2E"
export const WARNING = "#DBA92E"
export const MUTED = "var(--color-text-weak)"

export function tokens(count: number): string {
  if (count >= 1_000_000) return Math.round(count / 1_000_000) + "M"
  if (count >= 1_000) return Math.round(count / 1_000) + "k"
  return count.toString()
}

export function cost(dollars: number): string {
  return "$" + dollars.toFixed(2)
}

// Mirrors TUI utilizationColor: green under 75%, then hsv sweep green->red.
export function utilizationColor(percent: number): string {
  if (percent < 75) return GREEN
  const t = Math.min((percent - 75) / 25, 1)
  const hue = 120 * (1 - t)
  const s = 0.85
  const v = 0.9
  const c = v * s
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = v - c
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : [0, c, x]
  const to = (n: number) =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, "0")
  return `#${to(r)}${to(g)}${to(b)}`
}

export function ProgressBar(props: { percent: number; width?: number }) {
  const width = () => props.width ?? 10
  const filled = () => Math.min(Math.round((props.percent / 100) * width()), width())
  return (
    <span>
      <span style={{ color: MUTED }}>[</span>
      <span style={{ color: utilizationColor(props.percent) }}>{"\u2593".repeat(filled())}</span>
      <span style={{ color: MUTED }}>{"\u2591".repeat(width() - filled())}</span>
      <span style={{ color: MUTED }}>]</span>
    </span>
  )
}

export function Pipe() {
  return <span style={{ color: MUTED }}> │ </span>
}

export type UsageStats = {
  total: number
  cached: number
  cacheWritten: number
  nextTurn: number
  limit: number
  percentage: number
}

export type SessionTotals = { input: number; output: number; cacheWrite: number }

// The single context-window derivation: sum the message's input + cache tokens
// against the provider's context limit. Used by both the live dock and the
// per-message footer so the formula lives in one place.
export function statsFromMessage(message: AssistantMessage, providers: ProviderLike[]): UsageStats | null {
  const t = message.tokens
  const total = t.input + t.cache.read + t.cache.write
  if (!total) return null
  const limit = providers.find((p) => p.id === message.providerID)?.models[message.modelID]?.limit?.context ?? 200000
  return {
    total,
    cached: t.cache.read,
    cacheWritten: t.cache.write,
    nextTurn: t.output,
    limit,
    percentage: Math.round((total / limit) * 100),
  }
}

// The TUI per-message snapshot line 2 (StatuslineContent compact): context bar,
// cache stats, and session totals + cost as of this message. The Σ totals and cost are session-cumulative (message.sessionTotal),
// not this message's isolated tokens/cost.
export function UsageLine(props: {
  stats: UsageStats
  totals: SessionTotals
  cost: number
  leading?: JSX.Element
  class?: string
}) {
  return (
    <div
      class={
        "flex flex-row flex-wrap items-center text-11-regular font-mono [font-variant-numeric:tabular-nums] leading-tight " +
        (props.class ?? "pt-0.5")
      }
    >
      <Show when={props.leading}>
        {props.leading}
        <Pipe />
      </Show>
      <span style={{ color: utilizationColor(props.stats.percentage) }}>{"\u25a3 "}</span>
      <ProgressBar percent={props.stats.percentage} width={10} />
      <span>
        {" "}
        <span class="font-semibold" style={{ color: utilizationColor(props.stats.percentage) }}>
          {tokens(props.stats.total)}
        </span>
        <span style={{ color: MUTED }}>/</span>
        <span style={{ color: MUTED }}>{tokens(props.stats.limit)}</span>
      </span>
      <Pipe />

      <span>
        <span style={{ color: GREEN }}>{"\u25c8 "}</span>
        <span class="font-semibold" style={{ color: GREEN }}>
          {tokens(props.stats.cached)}
        </span>
        <span style={{ color: MUTED }}> · </span>
        <span style={{ color: WARNING }}>{"\u2605 "}</span>
        <span class="font-semibold" style={{ color: WARNING }}>
          {tokens(props.stats.cacheWritten)}
        </span>
        <span style={{ color: MUTED }}> · </span>
        <span style={{ color: NEXT_TURN_ORANGE }}>{"\u25b2 "}</span>
        <span class="font-semibold" style={{ color: NEXT_TURN_ORANGE }}>
          {tokens(props.stats.nextTurn)}
        </span>
      </span>
      <Pipe />

      <span>
        <span style={{ color: "var(--color-text-base)" }}>{"\u03a3 "}</span>
        <span class="font-semibold" style={{ color: "var(--color-text-base)" }}>
          ↑{tokens(props.totals.input)}
        </span>
        <span style={{ color: MUTED }}> · </span>
        <span class="font-semibold" style={{ color: WARNING }}>
          ↓{tokens(props.totals.output)}
        </span>
        <span style={{ color: MUTED }}> · </span>
        <span class="font-semibold" style={{ color: NEXT_TURN_ORANGE }}>
          {"\u2295 " + tokens(props.totals.cacheWrite)}
        </span>
        <span style={{ color: MUTED }}> · </span>
        <span class="font-semibold" style={{ color: GREEN }}>
          {cost(props.cost)}
        </span>
      </span>
    </div>
  )
}
