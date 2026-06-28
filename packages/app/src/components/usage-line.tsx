import { Show, type JSX } from "solid-js"
import { Chip, ChipGroup } from "@opencode-ai/ui/chip"
import { Icon } from "@opencode-ai/ui/icon"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"

type ProviderLike = { id: string; models: Record<string, { limit?: { context?: number } }> }

export function tokens(count: number): string {
  if (count >= 1_000_000) return Math.round(count / 1_000_000) + "M"
  if (count >= 1_000) return Math.round(count / 1_000) + "k"
  return count.toString()
}

export function cost(dollars: number): string {
  return "$" + dollars.toFixed(2)
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

// The per-message / live-dock usage row: one Chip per metric,
// flowing and wrapping, replacing the old pipe-separated text line. The data
// derivation (statsFromMessage, sessionTotal) is unchanged; only the rendering
// is chips. Context is a gauge chip (background fills to the fraction); the
// rest are plain icon+value chips. `leading` (the dock's cache-countdown ring)
// renders as its own chip when present.
export function UsageLine(props: {
  stats: UsageStats
  totals: SessionTotals
  cost: number
  leading?: JSX.Element
  class?: string
}) {
  // Context fill color follows the same 75% threshold as utilizationColor:
  // below 75% the start (green) token, at/above the end (red) token.
  const contextFill = () => (props.stats.percentage >= 75 ? "usage-context-end" : "usage-context-start")
  const icon = (name: Parameters<typeof Icon>[0]["name"]) => <Icon name={name} class="size-3.5" />

  return (
    <div class={"flex flex-row flex-wrap items-center gap-1.5 " + (props.class ?? "pt-0.5")}>
      <Show when={props.leading}>
        <ChipGroup>
          <Chip>{props.leading}</Chip>
        </ChipGroup>
      </Show>

      {/* Context: solo gauge chip (fill = how full the window is). */}
      <ChipGroup>
        <Chip
          icon={icon("usage-context")}
          accent="usage-context-start"
          fill={props.stats.percentage / 100}
          fillColor={contextFill()}
          title={`Context ${tokens(props.stats.total)} / ${tokens(props.stats.limit)}`}
        >
          {tokens(props.stats.total)}/{tokens(props.stats.limit)}
        </Chip>
      </ChipGroup>

      {/* Per-turn group (this turn's activity): pulse marker · cached · write · next. */}
      <ChipGroup>
        <Chip icon={icon("usage-per-turn")} accent="usage-totals" title="This turn" />
        <Chip icon={icon("usage-cached")} accent="usage-cached" title="Cached (read from cache)">
          {tokens(props.stats.cached)}
        </Chip>
        <Chip icon={icon("usage-cache-write")} accent="usage-cache-write" title="Cache write">
          {tokens(props.stats.cacheWritten)}
        </Chip>
        <Chip icon={icon("usage-next-turn")} accent="usage-next-turn" title="Next turn (output)">
          {tokens(props.stats.nextTurn)}
        </Chip>
      </ChipGroup>

      {/* Session group (Σ cluster): sigma marker · input · output · cache-write · cost. */}
      <ChipGroup>
        <Chip icon={icon("usage-totals")} accent="usage-totals" title="Session totals" />
        <Chip icon={icon("usage-input")} accent="usage-totals" title="Session input tokens">
          {tokens(props.totals.input)}
        </Chip>
        <Chip icon={icon("usage-output")} accent="usage-cache-write" title="Session output tokens">
          {tokens(props.totals.output)}
        </Chip>
        <Chip icon={icon("usage-cache-write")} accent="usage-next-turn" title="Session cache write">
          {tokens(props.totals.cacheWrite)}
        </Chip>
        <Chip icon={icon("usage-cost")} accent="usage-cost" title="Session cost">
          {cost(props.cost)}
        </Chip>
      </ChipGroup>
    </div>
  )
}
