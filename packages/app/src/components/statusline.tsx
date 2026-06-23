import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useSync } from "@/context/sync"
import { useParams } from "@solidjs/router"

// Cache TTL mirrors the server's session/ping CACHE_TTL (5 minutes).
const CACHE_TTL = 5 * 60 * 1000

const GREEN = "#22DD22"
const NEXT_TURN_ORANGE = "#DB6A2E"
const WARNING = "#DBA92E"
const MUTED = "var(--color-text-weak)"

function tokens(count: number): string {
  if (count >= 1_000_000) return Math.round(count / 1_000_000) + "M"
  if (count >= 1_000) return Math.round(count / 1_000) + "k"
  return count.toString()
}

function cost(dollars: number): string {
  return "$" + dollars.toFixed(2)
}

// Mirrors TUI utilizationColor: green under 75%, then hsv sweep green->red.
function utilizationColor(percent: number): string {
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

function clock(ms: number): string {
  const d = new Date(ms)
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`
}

// Renders the TUI progress bar with ▓ (filled) and ░ (empty) blocks.
function ProgressBar(props: { percent: number; width?: number }) {
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

function Pipe() {
  return <span style={{ color: MUTED }}> │ </span>
}

export function Statusline() {
  const sync = useSync()
  const params = useParams()

  const session = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))

  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))

  const beforeExpiry = createMemo(() => ((sync.data.config as any)?.ping?.before_expiry ?? 10) * 1000)

  const cacheCountdown = createMemo(() => {
    const base = session()?.cache?.lastRequestAt
    if (!base) return null
    if (base + CACHE_TTL <= now()) return null
    const remaining = base + CACHE_TTL - beforeExpiry() - now()
    if (remaining <= 0) return null
    const mins = Math.floor(remaining / 60000)
    const secs = Math.floor((remaining % 60000) / 1000)
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
  })

  const cacheExpiryAbsolute = createMemo(() => {
    const base = session()?.cache?.lastRequestAt
    if (!base || base + CACHE_TTL <= now()) return null
    return clock(base + CACHE_TTL)
  })

  const pingPending = createMemo(() => session()?.ping?.pending ?? false)
  const pingCount = createMemo(() => session()?.ping?.count ?? 0)

  // Context window is derived from the last assistant message's token counts
  // (matches SessionContextUsage). Message tokens use nested cache.read/write.
  const context = createMemo(() => {
    const msgs = params.id ? sync.data.message[params.id] : undefined
    const last = msgs?.findLast((x) => {
      if (x.role !== "assistant") return false
      const t = x.tokens
      return t.input + t.output + t.reasoning + t.cache.read + t.cache.write > 0
    }) as any
    if (!last) return null
    const t = last.tokens
    const total = t.input + t.cache.read + t.cache.write
    if (!total) return null
    const limit =
      sync.data.provider.all.find((p) => p.id === last.providerID)?.models[last.modelID]?.limit?.context ?? 200000
    return {
      total,
      cached: t.cache.read,
      cacheWritten: t.cache.write,
      nextTurn: t.output,
      limit,
      percentage: Math.round((total / limit) * 100),
    }
  })

  const totals = createMemo(() => session()?.total ?? { input: 0, output: 0, cacheWrite: 0 })
  const sessionCost = createMemo(() => session()?.cost ?? 0)

  return (
    <Show when={context()}>
      {(stats) => (
        <div class="flex flex-row flex-wrap items-center px-2 py-1 text-11-regular font-mono [font-variant-numeric:tabular-nums] leading-tight">
          {/* Cache-expiry countdown */}
          <Tooltip
            value={
              <span>
                {cacheExpiryAbsolute() ? `◷ expires ${cacheExpiryAbsolute()}` : "◷ --"}
                {pingCount() > 0 ? ` (${pingCount()}× pinged)` : ""}
              </span>
            }
            placement="top"
          >
            <span style={{ color: WARNING }}>
              {"\u25f7 "}
              <Show
                when={!(pingPending() && !cacheCountdown())}
                fallback={<span class="animate-pulse font-semibold">{"\u00b7\u2009\u00b7\u2009\u00b7"}</span>}
              >
                <span class="font-semibold">{cacheCountdown() ?? "--"}</span>
              </Show>
            </span>
          </Tooltip>
          <Pipe />

          {/* Context bar */}
          <span style={{ color: utilizationColor(stats().percentage) }}>{"\u25a3 "}</span>
          <ProgressBar percent={stats().percentage} width={10} />
          <span>
            {" "}
            <span class="font-semibold" style={{ color: utilizationColor(stats().percentage) }}>
              {tokens(stats().total)}
            </span>
            <span style={{ color: MUTED }}>/</span>
            <span style={{ color: MUTED }}>{tokens(stats().limit)}</span>
          </span>
          <Pipe />

          {/* Cache stats: cached · write · next */}
          <span>
            <span style={{ color: GREEN }}>{"\u25c8 "}</span>
            <span class="font-semibold" style={{ color: GREEN }}>
              {tokens(stats().cached)}
            </span>
            <span style={{ color: MUTED }}> · </span>
            <span style={{ color: WARNING }}>{"\u2605 "}</span>
            <span class="font-semibold" style={{ color: WARNING }}>
              {tokens(stats().cacheWritten)}
            </span>
            <span style={{ color: MUTED }}> · </span>
            <span style={{ color: NEXT_TURN_ORANGE }}>{"\u25b2 "}</span>
            <span class="font-semibold" style={{ color: NEXT_TURN_ORANGE }}>
              {tokens(stats().nextTurn)}
            </span>
          </span>
          <Pipe />

          {/* Session totals + cost */}
          <span>
            <span style={{ color: "var(--color-text-base)" }}>{"\u03a3 "}</span>
            <span class="font-semibold" style={{ color: "var(--color-text-base)" }}>
              ↑{tokens(totals().input)}
            </span>
            <span style={{ color: MUTED }}> · </span>
            <span class="font-semibold" style={{ color: WARNING }}>
              ↓{tokens(totals().output)}
            </span>
            <span style={{ color: MUTED }}> · </span>
            <span class="font-semibold" style={{ color: NEXT_TURN_ORANGE }}>
              {"\u2295 " + tokens(totals().cacheWrite ?? 0)}
            </span>
            <span style={{ color: MUTED }}> · </span>
            <span class="font-semibold" style={{ color: GREEN }}>
              {cost(sessionCost())}
            </span>
          </span>
        </div>
      )}
    </Show>
  )
}
