import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, onCleanup } from "solid-js"
import { usePlatform } from "./platform"
import { useServer } from "./server"

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

    // Thin-client streaming model (like tmux reattach): the stream must run
    // forever. When it drops (server restart, sleep, network blip) reconnect
    // with backoff. The server emits server.connected on every (re)attach, so
    // global-sync re-bootstraps the world on that event — the "redraw" step.
    void (async () => {
      let backoff = 250
      while (!abort.signal.aborted) {
        try {
          const events = await eventSdk.global.event()
          backoff = 250
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

    return { url: server.url, client: sdk, event: emitter }
  },
})
