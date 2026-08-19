import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { batch, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import { Persist, persisted } from "@/utils/persist"

export function normalizeServerUrl(input: string) {
  const trimmed = input.trim()
  if (!trimmed) return
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
  return withProtocol.replace(/\/+$/, "")
}

export function serverDisplayName(url: string) {
  if (!url) return ""
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "")
}

function projectsKey(url: string) {
  if (!url) return ""
  const host = url.replace(/^https?:\/\//, "").split(":")[0]
  if (host === "localhost" || host === "127.0.0.1") return "local"
  return url
}

export const { use: useServer, provider: ServerProvider } = createSimpleContext({
  name: "Server",
  init: (props: { defaultUrl: string }) => {
    const platform = usePlatform()

    const [store, setStore, _, ready] = persisted(
      Persist.global("server", ["server.v3"]),
      createStore({
        list: [] as string[],
      }),
    )

    const [state, setState] = createStore({
      active: "",
      // Two views of the same question. The SSE stream sees a clean drop
      // instantly but leaves a half-open socket looking alive until its 60s
      // watchdog; the poll bounds that at one interval. Neither alone covers
      // both failures.
      polled: undefined as boolean | undefined,
      stream: undefined as boolean | undefined,
      version: undefined as string | undefined,
      host: undefined as string | undefined,
    })

    // Down beats up, so a drop never waits on the slower signal. Undefined is
    // "not yet known" — startup, a server switch, or a stream detached while
    // the tab is hidden — and must not render as a failure.
    const healthy = () => {
      if (state.polled === false || state.stream === false) return false
      if (state.polled === true || state.stream === true) return true
      return undefined
    }

    function setActive(input: string) {
      const url = normalizeServerUrl(input)
      if (!url) return
      setState("active", url)
    }

    function add(input: string) {
      const url = normalizeServerUrl(input)
      if (!url) return

      const fallback = normalizeServerUrl(props.defaultUrl)
      if (fallback && url === fallback) {
        setState("active", url)
        return
      }

      batch(() => {
        if (!store.list.includes(url)) {
          setStore("list", store.list.length, url)
        }
        setState("active", url)
      })
    }

    function remove(input: string) {
      const url = normalizeServerUrl(input)
      if (!url) return

      const list = store.list.filter((x) => x !== url)
      const next = state.active === url ? (list[0] ?? normalizeServerUrl(props.defaultUrl) ?? "") : state.active

      batch(() => {
        setStore("list", list)
        setState("active", next)
      })
    }

    createEffect(() => {
      if (!ready()) return
      if (state.active) return
      const url = normalizeServerUrl(props.defaultUrl)
      if (!url) return
      setState("active", url)
    })

    const isReady = createMemo(() => ready() && !!state.active)

    const check = (url: string) => {
      const signal = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout?.(3000)
      const sdk = createOpencodeClient({
        baseUrl: url,
        fetch: platform.fetch,
        signal,
      })
      return sdk.global
        .health()
        .then((x) => ({ healthy: x.data?.healthy === true, version: x.data?.version, host: x.data?.host }))
        .catch(() => ({ healthy: false, version: undefined, host: undefined }))
    }

    createEffect(() => {
      const url = state.active
      if (!url) return

      setState({ polled: undefined, stream: undefined, version: undefined, host: undefined })

      let alive = true
      let busy = false

      const run = () => {
        if (busy) return
        busy = true
        void check(url)
          .then((next) => {
            if (!alive) return
            // An unreachable server can't report its identity, so keep the last
            // known version/host rather than blanking the name on a blip.
            setState({
              polled: next.healthy,
              ...(next.healthy ? { version: next.version, host: next.host } : {}),
            })
          })
          .finally(() => {
            busy = false
          })
      }

      run()
      const interval = setInterval(run, 10_000)

      onCleanup(() => {
        alive = false
        clearInterval(interval)
      })
    })

    const isLocal = createMemo(() => projectsKey(state.active) === "local")

    // GlobalSDK owns the event stream and mounts below this provider, so it
    // reports liveness upward instead of this context reaching down for it.
    const setStream = (next: boolean | undefined) => setState("stream", next)

    return {
      ready: isReady,
      healthy,
      isLocal,
      setStream,
      get url() {
        return state.active
      },
      get name() {
        return serverDisplayName(state.active)
      },
      // The server's own identity (its hostname), which only a reachable server
      // reports; before the first health poll answers there is nothing but the
      // URL the browser dialed.
      get machine() {
        return state.host ?? serverDisplayName(state.active)
      },
      get version() {
        return state.version
      },
      get host() {
        return state.host
      },
      get list() {
        return store.list
      },
      setActive,
      add,
      remove,
    }
  },
})
