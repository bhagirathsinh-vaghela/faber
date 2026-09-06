import { createMemo, createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { useTheme } from "../../context/theme"
import { useSync } from "../../context/sync"
import { useDirectory } from "../../context/directory"
import { useConnected } from "../../component/dialog-model"
import { createStore } from "solid-js/store"
import { useRoute } from "../../context/route"
import { useKeybind } from "../../context/keybind"
import { useSDK } from "../../context/sdk"

export function Footer() {
  const { theme } = useTheme()
  const sync = useSync()
  const route = useRoute()
  const keybind = useKeybind()
  const sdk = useSDK()
  const mcp = createMemo(() => Object.values(sync.data.mcp).filter((x) => x.status === "connected").length)
  const mcpError = createMemo(() => Object.values(sync.data.mcp).some((x) => x.status === "failed"))
  const lsp = createMemo(() => Object.keys(sync.data.lsp))
  const permissions = createMemo(() => {
    if (route.data.type !== "session") return []
    return sync.data.permission[route.data.sessionID] ?? []
  })
  const pendingCount = createMemo(() => {
    if (route.data.type !== "session") return 0
    return sync.data.background_pending[route.data.sessionID] ?? 0
  })
  const directory = useDirectory()
  const connected = useConnected()
  const [autoInject, setAutoInject] = createSignal(true)

  // Fetch auto-inject state on mount and listen for changes
  onMount(async () => {
    if (route.data.type === "session") {
      const result = await sdk.client.background.getAutoInject({ sessionID: route.data.sessionID })
      setAutoInject(result.data?.autoInject ?? true)
    }
  })

  // Listen for auto-inject changes
  sdk.event.listen((e) => {
    if (e.details.type === "background.subagent.auto_inject_changed") {
      if (route.data.type === "session" && e.details.properties.sessionID === route.data.sessionID) {
        setAutoInject(e.details.properties.autoInject)
      }
    }
  })

  const [store, setStore] = createStore({
    welcome: false,
  })

  onMount(() => {
    // Track all timeouts to ensure proper cleanup
    const timeouts: ReturnType<typeof setTimeout>[] = []

    function tick() {
      if (connected()) return
      if (!store.welcome) {
        setStore("welcome", true)
        timeouts.push(setTimeout(() => tick(), 5000))
        return
      }

      if (store.welcome) {
        setStore("welcome", false)
        timeouts.push(setTimeout(() => tick(), 10_000))
        return
      }
    }
    timeouts.push(setTimeout(() => tick(), 10_000))

    onCleanup(() => {
      timeouts.forEach(clearTimeout)
    })
  })

  return (
    <box flexDirection="row" justifyContent="space-between" gap={1} flexShrink={0}>
      <text fg={theme.textMuted}>{directory()}</text>
      <box gap={2} flexDirection="row" flexShrink={0}>
        <Switch>
          <Match when={store.welcome}>
            <text fg={theme.text}>
              Get started <span style={{ fg: theme.textMuted }}>/connect</span>
            </text>
          </Match>
          <Match when={connected()}>
            <text fg={theme.text}>
              <span style={{ fg: autoInject() ? theme.success : theme.warning }}>⚡</span> Auto-inject{" "}
              {autoInject() ? "ON" : "OFF"} <span style={{ fg: theme.textMuted }}>ctrl+x i</span>
            </text>
            <Show when={pendingCount() > 0}>
              <text fg={theme.warning}>
                <span style={{ fg: theme.warning }}>◈</span> {pendingCount()} Pending{" "}
                <span style={{ fg: theme.textMuted }}>{keybind.print("accept_pending_results")}</span>
              </text>
            </Show>
            <Show when={permissions().length > 0}>
              <text fg={theme.warning}>
                <span style={{ fg: theme.warning }}>△</span> {permissions().length} Permission
                {permissions().length > 1 ? "s" : ""}
              </text>
            </Show>
            <text fg={theme.text}>
              <span style={{ fg: autoInject() ? theme.success : theme.warning }}>⚡</span> Auto-inject{" "}
              {autoInject() ? "ON" : "OFF"}{" "}
              <span style={{ fg: theme.textMuted }}>{keybind.print("background_auto_inject_toggle" as any)}</span>
            </text>
            <Show when={mcp()}>
              <text fg={theme.text}>
                <Switch>
                  <Match when={mcpError()}>
                    <span style={{ fg: theme.error }}>⊙ </span>
                  </Match>
                  <Match when={true}>
                    <span style={{ fg: theme.success }}>⊙ </span>
                  </Match>
                </Switch>
                {mcp()} MCP
              </text>
            </Show>
            <text fg={theme.textMuted}>/status</text>
          </Match>
        </Switch>
      </box>
    </box>
  )
}
