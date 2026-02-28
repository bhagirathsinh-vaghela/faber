// Statusline component naming guide
//
// Shared components (used in both input area and assistant message snapshots):
//   ModelHeader     — "header":   agent · model · provider · variant [· duration] [· interrupted]
//   StatuslineContent — renders the lines below, controlled by bold + compact props:
//     "directory"   — 📁 path:branch                    (input only, compact skips this)
//     "markers"     — 🔖 Cache: #0-19                   (input only, toggle via cache_markers_toggle keybind)
//     "tokens"      — ⏳ HH:MM:SS │ 🧠 [bar] N/M │ 📦 cached · ✨ new │ 💬 ↑in ↓out [│ 📁 path]
//                     compact mode: no cache expiry, directory appended at end
//
// Input area: ModelHeader(bold=true) + Statusline wrapper (bold=true, full layout)
// Snapshot:   ModelHeader(bold=false, +duration) + StatuslineContent(bold=false, compact=true)

import { createMemo, createSignal, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useSync } from "@tui/context/sync"
import { useDirectory } from "@tui/context/directory"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { RGBA, hsvToRgb } from "@opentui/core"

export const MODEL_COLOR = RGBA.fromHex("#E83CF5")

export const UTILIZATION_GREEN = RGBA.fromHex("#22DD22")

export function utilizationColor(percent: number) {
  if (percent < 75) return UTILIZATION_GREEN
  const t = Math.min((percent - 75) / 25, 1)
  const hue = 120 * (1 - t)
  return hsvToRgb(hue, 0.85, 0.9)
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
  directory: string
  cacheRanges?: Array<{ start: number; end: number }> | null
  showCacheMarkers?: boolean
  contextStats: { total: number; cached: number; newTokens: number; contextLimit: number; percentage: number } | null
  cacheExpiry: string | null
  sessionTotals: { input: number; output: number }
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
}) {
  const { theme } = useTheme()
  const b = () => props.bold
  const d = () => (props.dimmed ? theme.textMuted : undefined)

  return (
    <box flexDirection="row" gap={1} flexWrap="wrap">
      <text>
        <span style={{ fg: d() ?? props.agentColor, bold: b() }}>{props.agent}</span>
      </text>
      <Show when={props.model}>
        <text fg={theme.textMuted}>·</text>
        <text flexShrink={0}>
          <span style={{ fg: d() ?? props.modelColor ?? theme.textMuted, bold: b() }}>{props.model}</span>
        </text>
      </Show>
      <Show when={props.provider}>
        <text fg={theme.textMuted}>·</text>
        <text>
          <span style={{ fg: d() ?? theme.textMuted, bold: b() }}>{props.provider}</span>
        </text>
      </Show>
      <Show when={props.variant}>
        {(variant) => (
          <>
            <text fg={theme.textMuted}>·</text>
            <text>
              <span style={{ fg: d() ?? theme.warning, bold: b() }}>{variant()}</span>
            </text>
          </>
        )}
      </Show>
      <Show when={props.duration}>
        {(dur) => (
          <>
            <text fg={theme.textMuted}>·</text>
            <text>
              <span style={{ fg: theme.textMuted, bold: b() }}>{dur()}</span>
            </text>
          </>
        )}
      </Show>
      <Show when={props.interrupted}>
        <text fg={theme.textMuted}>·</text>
        <text>
          <span style={{ fg: theme.textMuted, bold: b() }}>interrupted</span>
        </text>
      </Show>
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

  return (
    <box flexDirection="column" gap={0}>
      {/* Directory line (full mode only) */}
      <Show when={!props.compact}>
        <box flexDirection="row">
          <text>
            <span style={{ fg: m() }}>📁</span>{" "}
            <span style={{ fg: c(theme.primary), bold: b() }}>{props.directory}</span>
          </text>
        </box>
      </Show>

      {/* Cache-valid blocks (full mode only) */}
      <Show when={!props.compact && props.showCacheMarkers && props.cacheRanges}>
        {(ranges) => (
          <Show when={ranges().length}>
            <box flexDirection="row">
              <text>
                <span style={{ fg: m() }}>🔖</span> <span style={{ fg: m(), bold: b() }}>Cache markers: </span>
                <span style={{ fg: c(UTILIZATION_GREEN), bold: b() }}>{formatRanges(ranges())}</span>
              </text>
            </box>
          </Show>
        )}
      </Show>

      {/* Token stats line */}
      <Show when={props.contextStats}>
        {(stats) => (
          <box flexDirection="row">
            {/* Cache expiry (full mode only) */}
            <Show when={!props.compact}>
              <text>
                <span style={{ fg: m() }}>⏳</span>{" "}
                <span style={{ fg: c(theme.warning), bold: b() }}>{props.cacheExpiry ?? "--"}</span>
                <span style={{ fg: m() }}> │ </span>
              </text>
            </Show>
            <text>
              <span style={{ fg: m() }}>🧠</span>{" "}
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
              <span style={{ fg: m() }}>📦</span>{" "}
              <span style={{ fg: c(UTILIZATION_GREEN), bold: b() }}>{formatTokens(stats().cached)}</span>
              <span style={{ fg: m() }}> · </span>
              <span style={{ fg: m() }}>✨</span>{" "}
              <span style={{ fg: c(theme.warning), bold: b() }}>{formatTokens(stats().newTokens)}</span>
              <span style={{ fg: m() }}> │ </span>
              <span style={{ fg: m() }}>💬</span>{" "}
              <span style={{ fg: c(theme.primary), bold: b() }}>↑{formatTokens(props.sessionTotals.input)}</span>
              <span style={{ fg: m() }}> · </span>
              <span style={{ fg: c(theme.warning), bold: b() }}>↓{formatTokens(props.sessionTotals.output)}</span>
              {/* Directory appended (compact mode only) */}
              <Show when={props.compact}>
                <span style={{ fg: m() }}> │ </span>
                <span style={{ fg: m() }}>📁</span>{" "}
                <span style={{ fg: c(theme.primary), bold: b() }}>{props.directory}</span>
              </Show>
            </text>
          </box>
        )}
      </Show>
    </box>
  )
}

export type StatuslineProps = {
  sessionID?: string
  dimmed?: boolean
}

const [showCacheMarkers, setShowCacheMarkers] = createSignal(false)
export function toggleCacheMarkers() {
  setShowCacheMarkers((v) => !v)
}

export function Statusline(props: StatuslineProps) {
  const sync = useSync()
  const directory = useDirectory()

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

  const cacheExpiry = createMemo(() => {
    const last = lastAssistant()
    if (!last?.time.completed) return null
    const expiryTime = last.time.completed + 5 * 60 * 1000
    if (expiryTime <= Date.now()) return null
    const date = new Date(expiryTime)
    const hours = date.getHours().toString().padStart(2, "0")
    const minutes = date.getMinutes().toString().padStart(2, "0")
    const seconds = date.getSeconds().toString().padStart(2, "0")
    return `${hours}:${minutes}:${seconds}`
  })

  const contextStats = createMemo(() => {
    const s = session()
    const t = s?.tokens
    if (!t) return null
    const total = t.input + t.cacheRead + t.cacheWrite
    if (!total) return null
    const cached = t.cacheRead
    const newTokens = t.input + t.cacheWrite
    const contextLimit = modelInfo()?.limit.context ?? 200000
    const percentage = Math.round((total / contextLimit) * 100)
    return { total, cached, newTokens, contextLimit, percentage }
  })

  const sessionTotals = createMemo(() => {
    return session()?.total ?? { input: 0, output: 0 }
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
      directory={directory()}
      cacheRanges={cacheRanges()}
      showCacheMarkers={showCacheMarkers()}
      contextStats={contextStats()}
      cacheExpiry={cacheExpiry()}
      sessionTotals={sessionTotals()}
    />
  )
}
