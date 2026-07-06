import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Icon } from "@opencode-ai/ui/icon"
import { useSync } from "@/context/sync"
import { useParams } from "@solidjs/router"
import { UsageLine, statsFromMessage } from "@/components/usage-line"
import { CACHE_TTL, beforeExpiryMs, cacheCountdown as computeCountdown } from "@/utils/cache-countdown"

function clock(ms: number): string {
  const d = new Date(ms)
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`
}

export function Statusline() {
  const sync = useSync()
  const params = useParams()

  const session = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))

  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))

  const cacheCountdown = createMemo(() => computeCountdown(session(), beforeExpiryMs(sync.data.config), now()))

  const cacheExpiryAbsolute = createMemo(() => {
    const base = session()?.cache?.lastRequestAt
    if (!base || base + CACHE_TTL <= now()) return null
    return clock(base + CACHE_TTL)
  })

  const pingPending = createMemo(() => session()?.ping?.pending ?? false)
  const pingCount = createMemo(() => session()?.ping?.count ?? 0)

  // The dock mirrors the latest assistant message: same deriver as the
  // per-message footer (statsFromMessage), fed the last message instead of a
  // specific one. Session totals/cost come from that message's snapshot.
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
          class="px-2 py-0 md:py-1"
          stats={s()}
          totals={totals()}
          cost={sessionCost()}
          leading={
            <Tooltip
              value={
                <span>
                  {cacheExpiryAbsolute() ? `◷ expires ${cacheExpiryAbsolute()}` : "◷ --"}
                  {pingCount() > 0 ? ` (${pingCount()}× pinged)` : ""}
                </span>
              }
              placement="top"
            >
              <span
                class="inline-flex items-center gap-1 [&_[data-component=icon]]:!text-current"
                style={{ color: "var(--color-text-warning, #DBA92E)" }}
              >
                <Icon name="clock" class="size-4 [stroke-width:2.2]" />
                <Show
                  when={!(pingPending() && !cacheCountdown())}
                  fallback={<span class="animate-pulse font-semibold">{"\u00b7\u2009\u00b7\u2009\u00b7"}</span>}
                >
                  <span class="font-semibold">{cacheCountdown() ?? "--"}</span>
                </Show>
              </span>
            </Tooltip>
          }
        />
      )}
    </Show>
  )
}
