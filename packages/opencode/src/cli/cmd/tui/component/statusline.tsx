import { createMemo, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useSync } from "@tui/context/sync"
import { useDirectory } from "@tui/context/directory"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"

// Progress bar component with color coding based on utilization
function ProgressBar(props: { percent: number; width?: number }) {
  const { theme } = useTheme()
  const width = () => props.width ?? 10
  const filled = () => Math.min(Math.round((props.percent / 100) * width()), width())

  // Color based on utilization level
  const color = () => {
    if (props.percent >= 80) return theme.error
    if (props.percent >= 50) return theme.warning
    return theme.success
  }

  return (
    <text>
      <span style={{ fg: theme.textMuted }}>[</span>
      <span style={{ fg: color() }}>{"\u2593".repeat(filled())}</span>
      <span style={{ fg: theme.textMuted }}>{"\u2591".repeat(width() - filled())}</span>
      <span style={{ fg: theme.textMuted }}>]</span>
    </text>
  )
}

// Format token count (e.g., 1234 -> "1k", 1234567 -> "1M")
function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return Math.round(count / 1_000_000) + "M"
  }
  if (count >= 1_000) {
    return Math.round(count / 1_000) + "k"
  }
  return count.toString()
}

export type StatuslineProps = {
  sessionID?: string
}

export function Statusline(props: StatuslineProps) {
  const { theme } = useTheme()
  const sync = useSync()
  const directory = useDirectory()

  // Get messages for the current session
  const messages = createMemo(() => (props.sessionID ? (sync.data.message[props.sessionID] ?? []) : []))

  // Get last assistant message with token data
  const lastAssistant = createMemo(() => {
    return messages().findLast((x) => x.role === "assistant" && x.tokens.output > 0) as AssistantMessage | undefined
  })

  // Get model info for context window size
  const modelInfo = createMemo(() => {
    const last = lastAssistant()
    if (!last) return undefined
    return sync.data.provider.find((x) => x.id === last.providerID)?.models[last.modelID]
  })

  // Cache expiry - 5 minutes from last assistant message completion
  const cacheExpiry = createMemo(() => {
    const last = lastAssistant()
    if (!last?.time.completed) return null

    const expiryTime = last.time.completed + 5 * 60 * 1000 // 5 minutes in ms
    const now = Date.now()

    if (expiryTime <= now) return null // Already expired

    const date = new Date(expiryTime)
    const hours = date.getHours().toString().padStart(2, "0")
    const minutes = date.getMinutes().toString().padStart(2, "0")
    const seconds = date.getSeconds().toString().padStart(2, "0")
    return `${hours}:${minutes}:${seconds}`
  })

  // Context window calculations (current usage from last message)
  // Uses input-side tokens only (what fills the context window limit)
  // Inspired by Claude Code's statusline: current_context_tokens = input_tokens + cache_creation + cache_read
  const contextStats = createMemo(() => {
    const last = lastAssistant()
    if (!last) return null

    // Context window = input tokens only (uncached + cache_write + cache_read)
    // Output/reasoning tokens don't count against context window limit
    const total = last.tokens.input + last.tokens.cache.read + last.tokens.cache.write

    const cached = last.tokens.cache.read
    const newTokens = last.tokens.input + last.tokens.cache.write
    const contextLimit = modelInfo()?.limit.context ?? 200000
    const percentage = Math.round((total / contextLimit) * 100)

    return {
      total,
      cached,
      newTokens,
      contextLimit,
      percentage,
    }
  })

  // Session totals - sum tokens across all assistant messages
  // Input: uncached input + cache writes (new tokens added to context, excludes cache reads)
  // Output: output + reasoning tokens (all tokens generated)
  // Note: cache.read is excluded because it represents reused cached content, not new input
  const sessionTotals = createMemo(() => {
    const msgs = messages()
    let inputTotal = 0
    let outputTotal = 0

    for (const m of msgs) {
      if (m.role === "assistant") {
        inputTotal += m.tokens.input + m.tokens.cache.write
        outputTotal += m.tokens.output + m.tokens.reasoning
      }
    }

    return { input: inputTotal, output: outputTotal }
  })

  return (
    <box flexDirection="column" gap={0}>
      {/* Line 1: Directory (includes git branch info) */}
      <box flexDirection="row">
        <text>
          <span style={{ fg: theme.textMuted }}>📁</span> <span style={{ fg: theme.primary }}>{directory()}</span>
        </text>
      </box>

      {/* Line 2: Cache expiry | Context window | Cached/New tokens | Session totals */}
      <Show when={contextStats()}>
        {(stats) => (
          <box flexDirection="row">
            <text>
              <span style={{ fg: theme.textMuted }}>⏳</span>{" "}
              <span style={{ fg: theme.warning }}>{cacheExpiry() ?? "--"}</span>
              <span style={{ fg: theme.textMuted }}> │ </span>
              <span style={{ fg: theme.textMuted }}>🧠</span>{" "}
            </text>
            <ProgressBar percent={stats().percentage} width={10} />
            <text>
              {" "}
              <span style={{ fg: theme.primary }}>{formatTokens(stats().total)}</span>
              <span style={{ fg: theme.textMuted }}>/</span>
              <span style={{ fg: theme.textMuted }}>{formatTokens(stats().contextLimit)}</span>
              <span style={{ fg: theme.textMuted }}> │ </span>
              <span style={{ fg: theme.textMuted }}>📦</span>{" "}
              <span style={{ fg: theme.success }}>{formatTokens(stats().cached)}</span>
              <span style={{ fg: theme.textMuted }}> · </span>
              <span style={{ fg: theme.textMuted }}>✨</span>{" "}
              <span style={{ fg: theme.warning }}>{formatTokens(stats().newTokens)}</span>
              <span style={{ fg: theme.textMuted }}> │ </span>
              <span style={{ fg: theme.textMuted }}>💬</span>{" "}
              <span style={{ fg: theme.primary }}>↑{formatTokens(sessionTotals().input)}</span>
              <span style={{ fg: theme.textMuted }}> </span>
              <span style={{ fg: theme.warning }}>↓{formatTokens(sessionTotals().output)}</span>
            </text>
          </box>
        )}
      </Show>
    </box>
  )
}
