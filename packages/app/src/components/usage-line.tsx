import { Show, type JSX } from "solid-js"
import { Chip, ChipGroup } from "@opencode-ai/ui/chip"
import { Icon } from "@opencode-ai/ui/icon"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { useLocal } from "@/context/local"

type ProviderLike = { id: string; models: Record<string, { limit?: { context?: number } }> }

// Tolerate a missing count: old sessions/messages predate some token fields, so
// a persisted record can omit a leaf the renderer reads. Treat absent as zero,
// never crash.
export function tokens(count: number | undefined): string {
  const n = count ?? 0
  if (n >= 1_000_000) return Math.round(n / 1_000_000) + "M"
  if (n >= 1_000) return Math.round(n / 1_000) + "k"
  return n.toString()
}

export function cost(dollars: number | undefined): string {
  return "$" + (dollars ?? 0).toFixed(2)
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
  // The dock's cache-countdown chip. Passed as icon + value (+ tooltip) so it
  // renders through the SAME Chip layout as every other chip (icon slot + value
  // column with the transparent alignment bar), instead of a custom blob that
  // sat misaligned.
  leading?: { icon: JSX.Element; value: JSX.Element; tooltip?: JSX.Element; accent?: string }
  class?: string
  // Dock variant on mobile: the outer wrapper is display:contents so the chip
  // groups become direct children of the dock chip row and spread evenly with
  // the action-bar chips (no separate flex box). Desktop keeps the flex row.
  flat?: boolean
}) {
  // Context fill color follows the same 75% threshold as utilizationColor:
  // below 75% the start (green) token, at/above the end (red) token.
  const contextFill = () => (props.stats.percentage >= 75 ? "usage-context-end" : "usage-context-start")
  const icon = (name: Parameters<typeof Icon>[0]["name"]) => <Icon name={name} class="size-4" />

  // Render-only show/hide: each chip is gated by the active surface's
  // visible set. Group markers (turn / Σ) are NOT in the registry —
  // a marker shows only when at least one chip in its group is visible
  // (no orphan markers). Order is canonical (source order here), never stored.
  const local = useLocal()
  const show = (id: string) => local.dock.isVisible(id)
  const anyTurn = () => show("cached") || show("cache-write") || show("next-turn")
  const anySession = () => show("input") || show("output") || show("session-cache-write") || show("cost")

  return (
    <div
      classList={{
        "flex flex-row flex-wrap items-center gap-x-1.5 gap-y-0.5": !props.flat,
        "contents @2xl/dock:flex @2xl/dock:flex-row @2xl/dock:flex-wrap @2xl/dock:items-center @2xl/dock:gap-x-1.5 @2xl/dock:gap-y-0.5": props.flat,
        [props.class ?? "pt-0.5"]: true,
      }}
    >
      <Show when={props.leading}>
        {(l) => (
          <ChipGroup>
            <Chip icon={l().icon} accent={l().accent} tooltip={l().tooltip}>
              {l().value}
            </Chip>
          </ChipGroup>
        )}
      </Show>

      {/* Context: solo gauge chip (fill = how full the window is). */}
      <Show when={show("context")}>
        <ChipGroup>
          <Chip
            icon={icon("usage-context")}
            accent="usage-id-context"
            fill={props.stats.percentage / 100}
            fillColor={contextFill()}
            tooltip={`Context window: ${tokens(props.stats.total)} of ${tokens(props.stats.limit)} used — how full the conversation is before older turns drop off.`}
          >
            {tokens(props.stats.total)}/{tokens(props.stats.limit)}
          </Chip>
        </ChipGroup>
      </Show>

      {/* Per-turn group (this turn's activity): cached · write · next. The group
          box + dividers carry the grouping, so no leading marker chip. */}
      <Show when={anyTurn()}>
        <ChipGroup>
          <Show when={show("cached")}>
            <Chip
              icon={icon("usage-cached")}
              accent="usage-context-start"
              tooltip="Reused from cache this turn — far cheaper and faster than sending fresh input."
            >
              {tokens(props.stats.cached)}
            </Chip>
          </Show>
          <Show when={show("cache-write")}>
            <Chip
              icon={icon("usage-cache-write")}
              accent="usage-cache-write"
              tooltip="Stored to cache this turn — costs a little extra now, makes future turns cheaper."
            >
              {tokens(props.stats.cacheWritten)}
            </Chip>
          </Show>
          <Show when={show("next-turn")}>
            <Chip
              icon={icon("usage-next-turn")}
              accent="usage-next-turn"
              tooltip="The context you carry into the next turn before new input — your starting cost for the next message."
            >
              {tokens(props.stats.nextTurn)}
            </Chip>
          </Show>
        </ChipGroup>
      </Show>

      {/* Session group: input · output · cache-write · cost. */}
      <Show when={anySession()}>
        <ChipGroup>
          <Show when={show("input")}>
            <Chip
              icon={icon("usage-input")}
              accent="usage-totals"
              tooltip="All tokens you've sent this session — your prompts plus the context fed each turn."
            >
              {tokens(props.totals.input)}
            </Chip>
          </Show>
          <Show when={show("output")}>
            <Chip
              icon={icon("usage-output")}
              accent="usage-cache-write"
              tooltip="All tokens the model has generated for you this session."
            >
              {tokens(props.totals.output)}
            </Chip>
          </Show>
          <Show when={show("session-cache-write")}>
            <Chip
              icon={icon("usage-cache-write")}
              accent="usage-next-turn"
              tooltip="Total stored to cache this session — the upfront cost that keeps later turns cheap."
            >
              {tokens(props.totals.cacheWrite)}
            </Chip>
          </Show>
          <Show when={show("cost")}>
            <Chip
              icon={icon("usage-cost")}
              accent="usage-cost"
              tooltip="Total spent this session so far, across every turn."
            >
              {cost(props.cost)}
            </Chip>
          </Show>
        </ChipGroup>
      </Show>

    </div>
  )
}
