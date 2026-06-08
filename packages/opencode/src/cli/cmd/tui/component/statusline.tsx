// Statusline component naming guide
//
// Shared components (used in both input area and assistant message snapshots):
//   ModelHeader     — "header":   agent · model · provider · variant [· duration] [· interrupted] [· directory]
//   StatuslineContent — renders the lines below, controlled by bold + compact props:
//     "markers"     — ▣ Cache: #0-19                   (input only, toggle via cache_markers_toggle keybind)
//     "context"     — ◷ HH:MM:SS │ ▣ [bar] N/M │ ◈ cached · ★ write · ⚠ next │ Σ ↑in ↓out · ⊕total cache write · $cost
//
// Input area: ModelHeader(bold=true, directory with branch) + Statusline wrapper (bold=true, full layout)
// Snapshot:   ModelHeader(bold=false, +duration, directory without branch) + StatuslineContent(bold=false, compact=true)

import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useSync } from "@tui/context/sync"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { RGBA, hsvToRgb } from "@opentui/core"
import { CACHE_TTL } from "@/session/ping"
import "opentui-spinner/solid"

const STAR_SEQ = ["·", "✧", "✦", "✶", "✹", "✺", "✹", "✶", "✦", "✧", "·", "·"]

export function createStarWaveFrames(count: number, spacing = 2, separator = "") {
  const offsets = Array.from({ length: count }, (_, i) => i * spacing)
  const len = STAR_SEQ.length
  return Array.from({ length: len }, (_, i) => offsets.map((o) => STAR_SEQ[(i + o) % len]).join(separator))
}

const PING_PULSE_FRAMES = createStarWaveFrames(3, 3, " ")

export const MODEL_COLOR = RGBA.fromHex("#E83CF5")

export const UTILIZATION_GREEN = RGBA.fromHex("#22DD22")

const NEXT_TURN_ORANGE = RGBA.fromHex("#DB6A2E")

export function utilizationColor(percent: number) {
  if (percent < 75) return UTILIZATION_GREEN
  const t = Math.min((percent - 75) / 25, 1)
  const hue = 120 * (1 - t)
  return hsvToRgb(hue, 0.85, 0.9)
}

export function formatCost(dollars: number): string {
  return "$" + dollars.toFixed(2)
}

// Format token count (e.g., 1234 -> "1k", 1234567 -> "1M")
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return Math.round(count / 1_000_000) + "M"
  if (count >= 1_000) return Math.round(count / 1_000) + "k"
  return count.toString()
}

function computeCacheRanges(markers: number[]): Array<{ start: number; end: number }> {
  if (!markers.length) return []
  const sorted = [...markers].sort((a, b) => a - b)
  return sorted.map((m, i) => ({
    start: m,
    end: i < sorted.length - 1 ? Math.min(m + 19, sorted[i + 1] - 1) : m + 19,
  }))
}

function formatRanges(ranges: Array<{ start: number; end: number }>): string {
  return ranges.map((r) => (r.start === r.end ? `#${r.start}` : `#${r.start}-${r.end}`)).join(", ")
}

export type StatuslineContentProps = {
  bold: boolean
  dimmed?: boolean
  compact?: boolean
  cacheRanges?: Array<{ start: number; end: number }> | null
  showCacheMarkers?: boolean
  contextStats: {
    total: number
    cached: number
    cacheWritten: number
    nextTurn: number
    contextLimit: number
    percentage: number
  } | null
  cacheExpiry: string | null
  cacheExpiryAbsolute: string | null
  pingCount: number
  pingPending: boolean
  sessionTotals: { input: number; output: number; cacheWrite?: number }
  sessionCost: number
  streamIndicator?: string | null
}

export function ModelHeader(props: {
  bold: boolean
  dimmed?: boolean
  agent: string
  agentColor: RGBA
  model: string
  modelColor?: RGBA
  provider: string
  variant?: string | null
  duration?: string | null
  interrupted?: boolean
  directory?: string | null
}) {
  const { theme } = useTheme()
  const b = () => props.bold
  const d = () => (props.dimmed ? theme.textMuted : undefined)

  const parts = createMemo(() => {
    const result: Array<{ color: RGBA; text: string }> = []
    if (props.variant) result.push({ color: d() ?? theme.warning, text: props.variant })
    if (props.duration) result.push({ color: theme.textMuted, text: props.duration })
    if (props.interrupted) result.push({ color: theme.textMuted, text: "interrupted" })
    if (props.directory) result.push({ color: d() ?? theme.primary, text: props.directory })
    return result
  })

  return (
    <box flexDirection="row" columnGap={0} rowGap={0} flexWrap="wrap">
      <box flexShrink={0} flexDirection="row">
        <text>
          <span style={{ fg: d() ?? props.agentColor, bold: b() }}>{props.agent}</span>
        </text>
      </box>
      <Show when={props.model}>
        <box flexShrink={0} flexDirection="row">
          <text>
            <span style={{ fg: theme.textMuted }}> · </span>
            <span style={{ fg: d() ?? props.modelColor ?? theme.textMuted, bold: b() }}>{props.model}</span>
          </text>
        </box>
      </Show>
      <Show when={props.provider}>
        <box flexShrink={0} flexDirection="row">
          <text>
            <span style={{ fg: theme.textMuted }}> · </span>
            <span style={{ fg: d() ?? theme.textMuted, bold: b() }}>{props.provider}</span>
          </text>
        </box>
      </Show>
      {parts().map((p) => (
        <box flexShrink={0} flexDirection="row">
          <text>
            <span style={{ fg: theme.textMuted }}> · </span>
            <span style={{ fg: p.color, bold: b() }}>{p.text}</span>
          </text>
        </box>
      ))}
    </box>
  )
}

function ProgressBar(props: { percent: number; width?: number; dimmed?: boolean }) {
  const { theme } = useTheme()
  const width = () => props.width ?? 10
  const filled = () => Math.min(Math.round((props.percent / 100) * width()), width())
  const m = () => theme.textMuted

  return (
    <text>
      <span style={{ fg: m() }}>[</span>
      <span style={{ fg: props.dimmed ? m() : utilizationColor(props.percent) }}>{"\u2593".repeat(filled())}</span>
      <span style={{ fg: m() }}>{"\u2591".repeat(width() - filled())}</span>
      <span style={{ fg: m() }}>]</span>
    </text>
  )
}

export function StatuslineContent(props: StatuslineContentProps) {
  const { theme } = useTheme()
  const b = () => props.bold
  const m = () => theme.textMuted
  const c = (color: RGBA) => (props.dimmed ? m() : color)
  const [cacheHover, setCacheHover] = createSignal(false)

  return (
    <box flexDirection="column" gap={0}>
      {/* Cache-valid blocks (full mode only) */}
      <Show when={!props.compact && props.showCacheMarkers && props.cacheRanges}>
        {(ranges) => (
          <Show when={ranges().length}>
            <box flexDirection="row">
              <text>
                <span style={{ fg: c(UTILIZATION_GREEN) }}>{"\u25a3"}</span>{" "}
                <span style={{ fg: m(), bold: b() }}>Cache markers: </span>
                <span style={{ fg: c(UTILIZATION_GREEN), bold: b() }}>{formatRanges(ranges())}</span>
              </text>
            </box>
          </Show>
        )}
      </Show>

      {/* Context stats line */}
      <Show when={props.contextStats}>
        {(stats) => (
          <box flexDirection="row" flexWrap="wrap" columnGap={0} rowGap={0}>
            {/* Stream indicator segment */}
            <Show when={props.streamIndicator}>
              <box flexShrink={0} flexDirection="row">
                <text>
                  <span style={{ fg: c(UTILIZATION_GREEN) }}>{props.streamIndicator}</span>
                  <span style={{ fg: m() }}> │ </span>
                </text>
              </box>
            </Show>
            {/* Cache expiry segment (full mode only) */}
            <Show when={!props.compact}>
              <box flexShrink={0} flexDirection="row">
                <box
                  flexDirection="row"
                  onMouseOver={() => setCacheHover(true)}
                  onMouseOut={() => setCacheHover(false)}
                >
                  <text>
                    <span style={{ fg: c(theme.warning) }}>{"\u25f7"}</span>{" "}
                  </text>
                  <Show
                    when={props.pingPending && !props.cacheExpiry}
                    fallback={
                      <text>
                        <span style={{ fg: c(theme.warning), bold: b() }}>{props.cacheExpiry ?? "--"}</span>
                      </text>
                    }
                  >
                    <spinner frames={PING_PULSE_FRAMES} interval={150} color={c(theme.warning)} />
                  </Show>
                  <Show when={cacheHover()}>
                    <box position="absolute" left={-1} top={-1} zIndex={1000}>
                      <box paddingLeft={1} paddingRight={1} backgroundColor={theme.backgroundPanel}>
                        <text>
                          <span style={{ fg: c(theme.warning) }}>{"\u25f7"}</span>{" "}
                          {props.cacheExpiryAbsolute ? (
                            <>
                              <span style={{ fg: c(MODEL_COLOR) }}>expires </span>
                              <span style={{ fg: c(theme.text), bold: b() }}>{props.cacheExpiryAbsolute}</span>
                            </>
                          ) : (
                            <span style={{ fg: c(theme.text), bold: b() }}>--</span>
                          )}
                          {props.pingCount > 0 ? (
                            <span style={{ fg: c(theme.warning), bold: b() }}> ({props.pingCount}x pinged)</span>
                          ) : null}
                        </text>
                      </box>
                    </box>
                  </Show>
                </box>
                <text>
                  <span style={{ fg: m() }}> │ </span>
                </text>
              </box>
            </Show>
            {/* Context bar segment */}
            <box flexShrink={0} flexDirection="row">
              <text>
                <span style={{ fg: c(utilizationColor(stats().percentage)) }}>{"\u25a3"}</span>{" "}
              </text>
              <ProgressBar percent={stats().percentage} width={10} dimmed={props.dimmed} />
              <text>
                {" "}
                <span style={{ fg: c(utilizationColor(stats().percentage)), bold: b() }}>
                  {formatTokens(stats().total)}
                </span>
                <span style={{ fg: m() }}>/</span>
                <span style={{ fg: m(), bold: b() }}>{formatTokens(stats().contextLimit)}</span>
                <span style={{ fg: m() }}> │ </span>
              </text>
            </box>
            {/* Cache stats segment */}
            <box flexShrink={0} flexDirection="row">
              <text>
                <span style={{ fg: c(UTILIZATION_GREEN) }}>{"\u25c8"}</span>{" "}
                <span style={{ fg: c(UTILIZATION_GREEN), bold: b() }}>{formatTokens(stats().cached)}</span>
                <span style={{ fg: m() }}> · </span>
                <span style={{ fg: c(theme.warning) }}>{"\u2605"}</span>{" "}
                <span style={{ fg: c(theme.warning), bold: b() }}>{formatTokens(stats().cacheWritten)}</span>
                <span style={{ fg: m() }}> · </span>
                <span style={{ fg: c(NEXT_TURN_ORANGE) }}>{"\u25b2"}</span>{" "}
                <span style={{ fg: c(NEXT_TURN_ORANGE), bold: b() }}>{formatTokens(stats().nextTurn)}</span>
                <span style={{ fg: m() }}> │ </span>
              </text>
            </box>
            {/* Session totals segment */}
            <box flexShrink={0} flexDirection="row">
              <text>
                <span style={{ fg: c(theme.primary) }}>{"\u03a3"}</span>{" "}
                <span style={{ fg: c(theme.primary), bold: b() }}>↑{formatTokens(props.sessionTotals.input)}</span>
                <span style={{ fg: m() }}> · </span>
                <span style={{ fg: c(theme.warning), bold: b() }}>↓{formatTokens(props.sessionTotals.output)}</span>
                <span style={{ fg: m() }}> · </span>
                <span style={{ fg: c(NEXT_TURN_ORANGE), bold: b() }}>
                  {"\u2295 " + formatTokens(props.sessionTotals.cacheWrite ?? 0)}
                </span>
                <span style={{ fg: m() }}> · </span>
                <span style={{ fg: c(UTILIZATION_GREEN), bold: b() }}>{formatCost(props.sessionCost)}</span>
              </text>
            </box>
          </box>
        )}
      </Show>
    </box>
  )
}

export type StatuslineProps = {
  sessionID?: string
  dimmed?: boolean
  streamIndicator?: string | null
}

const [showCacheMarkers, setShowCacheMarkers] = createSignal(false)
export function toggleCacheMarkers() {
  setShowCacheMarkers((v) => !v)
}

export function Statusline(props: StatuslineProps) {
  const sync = useSync()

  const session = createMemo(() => (props.sessionID ? sync.session.get(props.sessionID) : undefined))
  const messages = createMemo(() => (props.sessionID ? (sync.data.message[props.sessionID] ?? []) : []))

  const lastAssistant = createMemo(() => {
    return messages().findLast(
      (x) => x.role === "assistant" && (x.tokens.output > 0 || x.tokens.input > 0 || x.tokens.cache.read > 0),
    ) as AssistantMessage | undefined
  })

  const modelInfo = createMemo(() => {
    const last = lastAssistant()
    if (!last) return undefined
    return sync.data.provider.find((x) => x.id === last.providerID)?.models[last.modelID]
  })

  // Cache TTL is anchored to the last request's dispatch time (organic turn or
  // ping), stamped server-side. No fallback: until the first request of this
  // session stamps it, the countdown simply shows nothing.
  const cacheBase = createMemo(() => session()?.cache?.lastRequestAt ?? null)

  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))

  const before = createMemo(() => (sync.data.config.ping?.before_expiry ?? 10) * 1000)

  const cacheCountdown = createMemo(() => {
    const base = cacheBase()
    if (!base) return null
    if (base + CACHE_TTL <= now()) return null // cache expired
    const pingAt = base + CACHE_TTL - before()
    const remaining = pingAt - now()
    if (remaining <= 0) return null
    const mins = Math.floor(remaining / 60000)
    const secs = Math.floor((remaining % 60000) / 1000)
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
  })

  const cacheExpiryAbsolute = createMemo(() => {
    const base = cacheBase()
    if (!base) return null
    const expiry = base + CACHE_TTL
    if (expiry <= Date.now()) return null
    const date = new Date(expiry)
    return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}:${date.getSeconds().toString().padStart(2, "0")}`
  })

  const pingCount = createMemo(() => session()?.ping?.count ?? 0)
  const pingPending = createMemo(() => session()?.ping?.pending ?? false)

  const contextStats = createMemo(() => {
    const s = session()
    const t = s?.tokens
    if (!t) return null
    const total = t.input + t.cacheRead + t.cacheWrite
    if (!total) return null
    const cached = t.cacheRead
    const cacheWritten = t.cacheWrite
    const nextTurn = t.output
    const contextLimit = modelInfo()?.limit.context ?? 200000
    const percentage = Math.round((total / contextLimit) * 100)
    return { total, cached, cacheWritten, nextTurn, contextLimit, percentage }
  })

  const sessionTotals = createMemo(() => {
    return session()?.total ?? { input: 0, output: 0, cacheWrite: 0 }
  })

  const sessionCost = createMemo(() => {
    return session()?.cost ?? 0
  })

  const cacheRanges = createMemo(() => {
    const s = session()
    const markers = s?.cacheMarkers
    if (!markers?.length) return null
    return computeCacheRanges(markers)
  })

  return (
    <StatuslineContent
      bold={true}
      dimmed={props.dimmed}
      cacheRanges={cacheRanges()}
      showCacheMarkers={showCacheMarkers()}
      contextStats={contextStats()}
      cacheExpiry={cacheCountdown()}
      cacheExpiryAbsolute={cacheExpiryAbsolute()}
      pingCount={pingCount()}
      pingPending={pingPending()}
      sessionTotals={sessionTotals()}
      sessionCost={sessionCost()}
      streamIndicator={props.streamIndicator}
    />
  )
}
