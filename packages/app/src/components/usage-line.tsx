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
          tooltip={`Context window: ${tokens(props.stats.total)} of ${tokens(props.stats.limit)} used — how full the conversation is before older turns drop off.`}
        >
          {tokens(props.stats.total)}/{tokens(props.stats.limit)}
        </Chip>
      </ChipGroup>

      {/* Per-turn group (this turn's activity): pulse marker · cached · write · next. */}
      <ChipGroup>
        <Chip icon={icon("usage-per-turn")} accent="usage-totals" tooltip="turn" />
        <Chip
          icon={icon("usage-cached")}
          accent="usage-cached"
          tooltip="Reused from cache this turn — far cheaper and faster than sending fresh input."
        >
          {tokens(props.stats.cached)}
        </Chip>
        <Chip
          icon={icon("usage-cache-write")}
          accent="usage-cache-write"
          tooltip="Stored to cache this turn — costs a little extra now, makes future turns cheaper."
        >
          {tokens(props.stats.cacheWritten)}
        </Chip>
        <Chip
          icon={icon("usage-next-turn")}
          accent="usage-next-turn"
          tooltip="The context you carry into the next turn before new input — your starting cost for the next message."
        >
          {tokens(props.stats.nextTurn)}
        </Chip>
      </ChipGroup>

      {/* Session group (Σ cluster): sigma marker · input · output · cache-write · cost. */}
      <ChipGroup>
        <Chip icon={icon("usage-totals")} accent="usage-totals" tooltip="Session totals" />
        <Chip
          icon={icon("usage-input")}
          accent="usage-totals"
          tooltip="All tokens you've sent this session — your prompts plus the context fed each turn."
        >
          {tokens(props.totals.input)}
        </Chip>
        <Chip
          icon={icon("usage-output")}
          accent="usage-cache-write"
          tooltip="All tokens the model has generated for you this session."
        >
          {tokens(props.totals.output)}
        </Chip>
        <Chip
          icon={icon("usage-cache-write")}
          accent="usage-next-turn"
          tooltip="Total stored to cache this session — the upfront cost that keeps later turns cheap."
        >
          {tokens(props.totals.cacheWrite)}
        </Chip>
        <Chip icon={icon("usage-cost")} accent="usage-cost" tooltip="Total spent this session so far, across every turn.">
          {cost(props.cost)}
        </Chip>
      </ChipGroup>
    </div>
  )
}
