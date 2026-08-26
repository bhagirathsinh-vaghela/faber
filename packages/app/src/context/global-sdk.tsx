import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, createEffect, onCleanup } from "solid-js"
import { usePlatform } from "./platform"
import { useServer } from "./server"
import { Visibility } from "@/utils/visibility"
import { revalidate } from "@/utils/revalidate"
import { HEARTBEAT_MS, IDLE_MS, RESUME_MS } from "@opencode-ai/util/stream"

export const { use: useGlobalSDK, provider: GlobalSDKProvider } = createSimpleContext({
  name: "GlobalSDK",
  init: () => {
    const server = useServer()
    const platform = usePlatform()
    const abort = new AbortController()

    const eventSdk = createOpencodeClient({
      baseUrl: server.url,
      signal: abort.signal,
      fetch: platform.fetch,
    })

    // Per-connection event scoping. A stable id ties this client's
    // SSE stream to its declared interest set on the server; the server drops
    // other sessions' streaming events for us. Generated once per app load and
    // reused across reconnects so the server keeps our set.
    const connectionID = crypto.randomUUID()
    let interest: string[] = []
    let interestDirectory: string | undefined
    let interestBusySession: string | undefined
    const emitter = createGlobalEmitter<{
      [key: string]: Event
    }>()

    type Queued = { directory: string; payload: Event }

    let queue: Array<Queued | undefined> = []
    let buffer: Array<Queued | undefined> = []
    const coalesced = new Map<string, number>()
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0

    const key = (directory: string, payload: Event) => {
      if (payload.type === "session.status") return `session.status:${directory}:${payload.properties.sessionID}`
      if (payload.type === "lsp.updated") return `lsp.updated:${directory}`
      if (payload.type === "message.part.updated") {
        const part = payload.properties.part
        return `message.part.updated:${directory}:${part.messageID}:${part.id}`
      }
    }

    // Decide how a same-key event already waiting in this flush window collapses
    // with the arriving one. Returns the event to keep and whether to DROP the
    // earlier slot. For idempotent state (session.status/lsp.updated) the latest
    // always wins and the old slot drops. message.part.updated deltas are
    // ADDITIVE (server blanked the part, client appends), so:
    //   prev delta + next delta  -> concat deltas, keep next part, drop prev.
    //   prev delta + next full    -> next full text supersedes, drop prev.
    //   prev full  + next delta   -> next appends onto prev's full text, so KEEP
    //                                prev (do not drop): both apply, in order.
    //   prev full  + next full    -> next supersedes, drop prev.
    const collapse = (prev: Queued | undefined, next: Queued): { keep: Queued; drop: boolean } => {
      if (!prev) return { keep: next, drop: false }
      const a = prev.payload
      const b = next.payload
      if (a.type !== "message.part.updated" || b.type !== "message.part.updated") return { keep: next, drop: true }
      const prevDelta = a.properties.delta
      const nextDelta = b.properties.delta
      if (nextDelta === undefined) return { keep: next, drop: true }
      if (prevDelta === undefined) return { keep: next, drop: false }
      return {
        keep: {
          directory: next.directory,
          payload: { ...b, properties: { ...b.properties, delta: prevDelta + nextDelta } },
        },
        drop: true,
      }
    }

    const flush = () => {
      if (timer) clearTimeout(timer)
      timer = undefined

      if (queue.length === 0) return

      const events = queue
      queue = buffer
      buffer = events
      queue.length = 0
      coalesced.clear()

      last = Date.now()
      batch(() => {
        for (const event of events) {
          if (!event) continue
          emitter.emit(event.directory, event.payload)
        }
      })

      buffer.length = 0
    }

    // Render-batching window: coalesce incoming events into one Solid flush per
    // FLUSH_MS instead of one per event (the server already coalesces text on the
    // wire at ~80ms; this is the browser-side reactive pass). Leading-edge, so a
    // lone event still flushes within the window of the last one. 48ms (~3 frames)
    // cuts flushes ~3x on a fast stream vs the old 16ms with no perceptible lag,
    // now that collapse() concatenates additive deltas so a wider window can't
    // drop streamed text.
    const FLUSH_MS = 48
    const schedule = () => {
      if (timer) return
      const elapsed = Date.now() - last
      timer = setTimeout(flush, Math.max(0, FLUSH_MS - elapsed))
    }

    // Declare (or re-declare) which sessions this connection wants. Fire-and-
    // forget: on failure the server just keeps our previous set (or fail-open if
    // none), so a dropped subscribe over-sends but never drops events.
    const pushInterest = () =>
      eventSdk.global
        .subscribe({
          connectionID,
          sessions: interest,
          directory: interestDirectory,
          busySession: interestBusySession,
        })
        .catch(() => {})

    // Update the message interest set AND the busy scope, then push. `sessions`
    // is the message-streaming set (open + children + juggled live sessions).
    // `busySession` is the single open session whose subtree the busy tick heals
    // (undefined on the overview). `directory` routes the busy tick frame back.
    const subscribe = (sessions: string[], directory?: string, busySession?: string) => {
      interest = sessions
      interestDirectory = directory
      interestBusySession = busySession
      return pushInterest()
    }

    // Close the stream while the tab is hidden and rebuild it on resume:
    // iOS silently kills a backgrounded SSE connection anyway, and
    // holding one open burns battery for events we are not painting. `attempt`
    // is the current stream's abort handle; aborting it breaks the for-await and
    // drops the loop into its wait-for-visible gate. On resume the loop
    // re-attaches, the server emits server.connected, and global-sync heals the
    // gap via the since-id delta. A no-op when the document API is absent.
    let attempt: AbortController | undefined

    // A device leaving a tunnel should reconnect on the signal that it left,
    // not on a timer that knows nothing about it — and that timer is longest
    // exactly when the outage was longest.
    //
    // A signal arriving while the loop is NOT sleeping is remembered rather than
    // dropped, since the common ordering is an abort immediately followed by a
    // nudge, which lands before the loop has reached its sleep. The sleeper is
    // held with the generation that created it so a superseded timer firing late
    // cannot release, or silently discard, a later sleep.
    let wake: { generation: number; resolve: () => void } | undefined
    let generation = 0
    let pendingWake = false
    const nudge = () => {
      if (!wake) {
        pendingWake = true
        return
      }
      wake.resolve()
      wake = undefined
    }
    const backoffSleep = (ms: number) => {
      if (pendingWake) {
        pendingWake = false
        return Promise.resolve()
      }
      generation++
      const mine = generation
      return new Promise<void>((resolve) => {
        wake = { generation: mine, resolve }
        setTimeout(() => {
          if (wake?.generation !== mine) return
          wake = undefined
          resolve()
        }, ms)
      })
    }

    createEffect(() => {
      if (Visibility.hidden()) attempt?.abort()
    })
    // Passing a per-attempt signal to the SSE call overrides the client-level
    // lifetime signal, so cascade teardown to whatever stream is live.
    abort.signal.addEventListener("abort", () => attempt?.abort())

    // Read-liveness watchdog. On flaky wifi a connection can go half-open — the
    // socket is silently dead, so reader.read() never rejects and the for-await
    // below blocks forever with no reconnect. The server guarantees traffic on a
    // live link (server.heartbeat), so treat prolonged silence as dead: abort
    // the attempt to break the for-await into the backoff+reconnect path. pet()
    // resets it on every received event; the loop clears it whenever the stream
    // ends.
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const pet = () => {
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => attempt?.abort(), IDLE_MS)
    }
    // A suspicious signal (resume, network flap) revalidates the stream: reconnect
    // only when none is live, otherwise shorten the liveness deadline so a dead
    // stream is caught sooner while a healthy one keeps re-arming it and survives.
    const react = () => {
      if (revalidate(!!watchdog) === "reconnect") {
        nudge()
        return
      }
      clearTimeout(watchdog)
      watchdog = setTimeout(() => attempt?.abort(), RESUME_MS)
    }
    // Re-verify the stream every time the page returns to the foreground rather
    // than waiting out the idle budget.
    let resumeSeen = false
    createEffect(() => {
      Visibility.resumed()
      if (!resumeSeen) {
        resumeSeen = true
        return
      }
      if (Visibility.hidden()) return
      react()
    })
    // A network online/offline flap flips this signal. navigator.onLine flaps
    // spuriously on VPN/multi-interface machines, so it revalidates rather than
    // aborts — a healthy stream on a solid link must survive the flap. First run
    // only reads the signal to subscribe; there is nothing to recover.
    let netSeen = false
    createEffect(() => {
      Visibility.network()
      if (!netSeen) {
        netSeen = true
        return
      }
      react()
    })
    const rest = () => {
      if (!watchdog) return
      clearTimeout(watchdog)
      watchdog = undefined
    }

    // The newest frame this client has processed, replayed back to the server
    // on reconnect so it can hand over what was published during the gap. Held
    // as the server's own opaque string, which carries the process identity the
    // server needs to reject a cursor from a previous one. Survives across
    // attempts on purpose: a dropped stream is exactly when it matters, and only
    // the app's own loop spans those attempts.
    let cursor: string | undefined
    let epoch: string | undefined

    // Ceiling on the reconnect wait, so a long outage cannot climb to a delay
    // that outlasts the outage itself and leave the app idle after the link
    // returns.
    const RECONNECT_CAP_MS = 30000

    // Thin-client streaming model (like tmux reattach): the stream must run
    // forever. When it drops (server restart, sleep, network blip) reconnect
    // with backoff. The server emits server.connected on every (re)attach, so
    // global-sync re-bootstraps the world on that event — the "redraw" step.
    void (async () => {
      let backoff = 250
      while (!abort.signal.aborted) {
        // Hold off attaching while hidden; resume rebuilds unconditionally.
        await Visibility.whenVisible()
        if (abort.signal.aborted) break
        attempt = new AbortController()
        let attached = false
        try {
          // sseMaxRetryAttempts:1 disables the SDK's own retry loop, which
          // otherwise swallows a drop and sleeps 3-30s internally before
          // retrying — the app's for-await never sees the error and this fast
          // backoff never runs. Capping at one attempt surfaces the error out
          // of the stream so THIS loop owns reconnection on its own fast clock.
          const events = await eventSdk.global.event(
            { connectionID },
            {
              signal: attempt.signal,
              sseMaxRetryAttempts: 1,
              // Resume from the last frame this client processed, so the server
              // hands back what was published while the stream was down.
              ...(cursor === undefined ? {} : { headers: { "Last-Event-ID": String(cursor) } }),
            },
          )
          backoff = 250
          attached = true
          server.setStream(true)
          pet()
          // Re-declare interest on every (re)attach: the server registry is
          // per-process, so a restart wiped our set and would otherwise fail-open
          // (harmless over-send) until we re-push. Snapshot heals any gap via
          // reconcile-by-id, so order here is not load-bearing.
          void pushInterest()
          let yielded = Date.now()
          for await (const event of events.stream) {
            pet()
            // The connect frame carries the server's process identity with its
            // id; every later frame carries only the number, so the identity is
            // held from the former and reapplied to the latter.
            if (event.payload?.type === "server.connected") epoch = event.payload.properties.cursor?.split(":")[0]
            if (event.id !== undefined && epoch) cursor = `${epoch}:${event.id}`
            const directory = event.directory ?? "global"
            const payload = event.payload
            const k = key(directory, payload)
            let queued: Queued = { directory, payload }
            if (k) {
              const i = coalesced.get(k)
              const { keep, drop } = collapse(i !== undefined ? queue[i] : undefined, queued)
              queued = keep
              // Only null the earlier slot when it is safe to drop it. A queued
              // full-part event followed by a delta must stay (the delta appends
              // onto its text), so we keep both and coalesce future events against
              // this newer one instead.
              if (i !== undefined && drop) queue[i] = undefined
              coalesced.set(k, queue.length)
            }
            queue.push(queued)
            schedule()

            if (Date.now() - yielded < 8) continue
            yielded = Date.now()
            await new Promise<void>((resolve) => setTimeout(resolve, 0))
          }
        } catch {
          // stream errored; fall through to backoff + reconnect
        }
        rest()
        flush()
        if (abort.signal.aborted) break
        // Only a stream that never attached is evidence of an outage: the
        // server did not answer at all. Attaching and then ending is ambiguous
        // (restart, network flap), and a hidden tab is detached on purpose —
        // both report unknown and let the next attach settle it.
        server.setStream(attached || Visibility.hidden() ? undefined : false)
        // Full Jitter (AWS): a restart drops every device at once, so an
        // unrandomised schedule would march them all back in step.
        await backoffSleep(Math.random() * backoff)
        backoff = Math.min(backoff * 2, RECONNECT_CAP_MS)
      }
    })()

    onCleanup(() => {
      abort.abort()
      rest()
      flush()
      server.setStream(undefined)
    })

    const sdk = createOpencodeClient({
      baseUrl: server.url,
      fetch: platform.fetch,
      throwOnError: true,
    })

    return { url: server.url, client: sdk, event: emitter, subscribe }
  },
})
