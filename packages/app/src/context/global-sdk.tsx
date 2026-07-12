import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, createEffect, onCleanup } from "solid-js"
import { usePlatform } from "./platform"
import { useServer } from "./server"
import { Visibility } from "@/utils/visibility"

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

    const schedule = () => {
      if (timer) return
      const elapsed = Date.now() - last
      timer = setTimeout(flush, Math.max(0, 16 - elapsed))
    }

    // Declare (or re-declare) which sessions this connection wants. Fire-and-
    // forget: on failure the server just keeps our previous set (or fail-open if
    // none), so a dropped subscribe over-sends but never drops events.
    const pushInterest = () => eventSdk.global.subscribe({ connectionID, sessions: interest }).catch(() => {})

    // Update the interest set and push it. Called by global-sync as the set of
    // sessions the client keeps mounted changes (open session + live sessions).
    const subscribe = (sessions: string[]) => {
      interest = sessions
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
    createEffect(() => {
      if (Visibility.hidden()) attempt?.abort()
    })
    // Passing a per-attempt signal to the SSE call overrides the client-level
    // lifetime signal, so cascade teardown to whatever stream is live.
    abort.signal.addEventListener("abort", () => attempt?.abort())

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
        try {
          const events = await eventSdk.global.event({ connectionID }, { signal: attempt.signal })
          backoff = 250
          // Re-declare interest on every (re)attach: the server registry is
          // per-process, so a restart wiped our set and would otherwise fail-open
          // (harmless over-send) until we re-push. Snapshot heals any gap via
          // reconcile-by-id, so order here is not load-bearing.
          void pushInterest()
          let yielded = Date.now()
          for await (const event of events.stream) {
            const directory = event.directory ?? "global"
            const payload = event.payload
            const k = key(directory, payload)
            if (k) {
              const i = coalesced.get(k)
              if (i !== undefined) {
                queue[i] = undefined
              }
              coalesced.set(k, queue.length)
            }
            queue.push({ directory, payload })
            schedule()

            if (Date.now() - yielded < 8) continue
            yielded = Date.now()
            await new Promise<void>((resolve) => setTimeout(resolve, 0))
          }
        } catch {
          // stream errored; fall through to backoff + reconnect
        }
        flush()
        if (abort.signal.aborted) break
        await new Promise<void>((resolve) => setTimeout(resolve, backoff))
        backoff = Math.min(backoff * 2, 5000)
      }
    })()

    onCleanup(() => {
      abort.abort()
      flush()
    })

    const sdk = createOpencodeClient({
      baseUrl: server.url,
      fetch: platform.fetch,
      throwOnError: true,
    })

    return { url: server.url, client: sdk, event: emitter, subscribe }
  },
})
