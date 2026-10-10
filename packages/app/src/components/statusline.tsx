import { createMemo, Show } from "solid-js"
import { CountdownRing } from "@opencode-ai/ui/countdown-ring"
import { useSync } from "@/context/sync"
import { useGlobalSync } from "@/context/global-sync"
import { useTicker } from "@/context/ticker"
import { useParams } from "@solidjs/router"
import { useOpenContext } from "@/hooks/use-open-context"
import { UsageLine, statsFromMessage } from "@/components/usage-line"
import { beforeExpiryMs, pingCountdown } from "@/utils/cache-countdown"

function clock(ms: number): string {
  const d = new Date(ms)
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`
}

export function Statusline() {
  const sync = useSync()
  const globalSync = useGlobalSync()
  const params = useParams()
  const openContext = useOpenContext()

  const session = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))

  const { now } = useTicker()

  // The live scheduled-ping deadline from the hub — the SAME source the overview
  // reads, and cleared server-side the instant the daemon disarms. Gating the
  // countdown on this (not the raw cache anchor) is what makes a stopped session
  // read "--" here just as it does in the overview: no daemon, no pingAt, no
  // countdown, even though cache.lastRequestAt still lingers.
  const pingAt = createMemo(() => globalSync.data.recent_hub.find((r) => r.sessionID === params.id)?.pingAt)

  // countdown text + ring fraction from the ONE shared predicate, identical to
  // the overview. Differ only in styling below.
  const ping = createMemo(() => pingCountdown(pingAt(), beforeExpiryMs(sync.data.config), now()))
  const cacheCountdown = createMemo(() => ping().text)
  const cacheFraction = createMemo(() => ping().fraction)

  const pingAbsolute = createMemo(() => {
    const at = pingAt()
    if (!at || at <= now()) return null
    return clock(at)
  })

  const pingPending = createMemo(() => session()?.ping?.pending ?? false)
  const pingCount = createMemo(() => session()?.ping?.count ?? 0)

  // The dock mirrors the latest assistant message: same deriver as the
  // per-message footer (statsFromMessage), fed the last message instead of a
  // specific one. Session totals/cost come from the live session record.
  const lastMessage = createMemo(() => {
    const msgs = params.id ? sync.data.message[params.id] : undefined
    const last = msgs?.findLast((x) => {
      if (x.role !== "assistant") return false
      const t = x.tokens
      return t.input + t.output + t.reasoning + t.cache.read + t.cache.write > 0
    })
    return last?.role === "assistant" ? last : undefined
  })

  const stats = createMemo(() => {
    const m = lastMessage()
    return m ? statsFromMessage(m, sync.data.provider.all) : null
  })

  const totals = createMemo(() => session()?.total ?? { input: 0, output: 0, cacheWrite: 0 })
  const sessionCost = createMemo(() => session()?.cost ?? 0)
  return (
    <Show when={stats()}>
      {(s) => (
        <UsageLine
          flat
          class="px-2 py-0 dock-wide:py-1"
          stats={s()}
          totals={totals()}
          cost={sessionCost()}
          onContextClick={openContext}
          leading={{
            accent: "model",
            icon: <CountdownRing fraction={cacheFraction()} color="var(--model)" />,
            tooltip: (
              <span>
                {pingAbsolute() ? `◷ pings ${pingAbsolute()}` : "◷ --"}
                {pingCount() > 0 ? ` (${pingCount()}× pinged)` : ""}
              </span>
            ),
            value: (
              <Show
                when={!(pingPending() && !cacheCountdown())}
                fallback={<span class="animate-pulse">{"\u00b7\u2009\u00b7\u2009\u00b7"}</span>}
              >
                {cacheCountdown() ?? "--"}
              </Show>
            ),
          }}
        />
      )}
    </Show>
  )
}
