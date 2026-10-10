import { createMemo, For, Show } from "solid-js"
import { Popover } from "@opencode-ai/ui/popover"
import { Tabs } from "@opencode-ai/ui/tabs"
import { Button } from "@opencode-ai/ui/button"
import { useSyncOptional } from "@/context/sync"
import { useServer } from "@/context/server"
import { useLanguage } from "@/context/language"
import { shortHost } from "@/utils/short-host"

export function StatusPopover() {
  // Optional: on the home route this control renders outside the session Sync/SDK
  // providers, so these are undefined there. The trigger (server name + health)
  // needs only useServer; the mcp/lsp/plugin panels guard on these being present.
  const sync = useSyncOptional()
  const server = useServer()
  const language = useLanguage()

  const machineName = createMemo(() => server.machine)
  // Button shows the short host so a long hostname on disconnect can't overrun
  // the titlebar and tuck the sibling buttons. The popover still shows the full
  // machineName().
  const shortName = createMemo(() => shortHost(machineName()))

  const mcpItems = createMemo(() =>
    Object.entries(sync?.data.mcp ?? {})
      .map(([name, status]) => ({ name, status: status.status }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  )

  const mcpConnected = createMemo(() => mcpItems().filter((i) => i.status === "connected").length)

  // A bare count of the connected servers reads as the total and hides the ones
  // that are not, so show the fraction whenever they disagree.
  const mcpLabel = createMemo(() => {
    const eligible = mcpItems().filter((i) => i.status !== "disabled").length
    if (eligible === 0) return ""
    if (mcpConnected() === eligible) return `${eligible} `
    return `${mcpConnected()}/${eligible} `
  })

  const lspItems = createMemo(() => sync?.data.lsp ?? [])
  const lspCount = createMemo(() => lspItems().length)
  const plugins = createMemo(() => sync?.data.config.plugin ?? [])
  const pluginCount = createMemo(() => plugins().length)

  const mcpSeverity = createMemo(() => {
    if (mcpItems().some((m) => m.status === "failed")) return "critical"
    if (mcpItems().some((m) => m.status === "needs_auth" || m.status === "needs_client_registration")) return "warning"
    return undefined
  })

  const lspSeverity = createMemo(() => (lspItems().some((l) => l.status === "error") ? "critical" : undefined))

  // Suppressed while the server is unreachable: the mcp and lsp maps are then a
  // snapshot from before it went away, so any subsystem fault they report is
  // unverifiable. Server reachability subsumes it anyway.
  const degraded = createMemo(() => {
    if (server.healthy() !== true) return undefined
    if (mcpSeverity() === "critical" || lspSeverity() === "critical") return "critical"
    return mcpSeverity()
  })

  return (
    <Popover
      triggerAs={Button}
      triggerProps={{
        variant: "ghost",
        class:
          "rounded-sm max-w-[140px] min-w-0 shrink py-1.5 pr-3 pl-2 gap-2 border-none shadow-none data-[expanded]:bg-surface-raised-base-active",
        style: { scale: 1 },
        // The visible label is the server's short name, which says nothing
        // about what the control opens.
        "aria-label": language.t("status.popover.trigger"),
      }}
      trigger={
        <div class="flex items-center gap-1.5 min-w-0">
          {/* ring-offset paints its gap, which cannot match a ghost trigger
              that restyles its background on hover and expand. */}
          <div
            classList={{
              "flex items-center justify-center shrink-0 rounded-full size-3": true,
              border: !!degraded(),
              "border-icon-critical-base": degraded() === "critical",
              "border-icon-warning-base": degraded() === "warning",
            }}
          >
            <div
              data-slot="server-health"
              data-health={server.status() ?? "unknown"}
              classList={{
                "size-1.5 rounded-full shrink-0": true,
                "bg-icon-success-base": server.status() === "live",
                "bg-icon-warning-base": server.status() === "stale",
                "bg-icon-critical-base": server.status() === "down",
                "bg-border-weak-base": server.status() === undefined,
              }}
            />
          </div>
          <span class="text-12-regular text-text-strong truncate">{shortName()}</span>
        </div>
      }
      class="[&_[data-slot=popover-body]]:p-0 w-[360px] max-w-[calc(100vw-40px)] bg-transparent border-0 shadow-none rounded-xl"
      gutter={6}
      placement="bottom-end"
      shift={-136}
    >
      <div class="flex items-center gap-1 w-[360px] rounded-xl shadow-[var(--shadow-lg-border-base)]">
        <Tabs
          aria-label={language.t("status.popover.ariaLabel")}
          class="tabs glass-dense rounded-xl overflow-hidden"
          data-component="tabs"
          data-active="servers"
          defaultValue="servers"
          variant="alt"
        >
          <Tabs.List data-slot="tablist" class="bg-transparent border-b-0 px-4 pt-2 pb-0 gap-4 h-(--control-bar)">
            <Tabs.Trigger value="servers" data-slot="tab" class="text-12-regular">
              <Show when={server.status() === "down"}>
                <span class="size-1.5 rounded-full shrink-0 bg-icon-critical-base inline-block mr-1.5" />
              </Show>
              {language.t("status.popover.tab.servers")}
            </Tabs.Trigger>
            <Tabs.Trigger value="mcp" data-slot="tab" class="text-12-regular">
              <Show when={mcpSeverity()}>
                <span
                  classList={{
                    "size-1.5 rounded-full shrink-0 inline-block mr-1.5": true,
                    "bg-icon-critical-base": mcpSeverity() === "critical",
                    "bg-icon-warning-base": mcpSeverity() === "warning",
                  }}
                />
              </Show>
              {mcpLabel()}
              {language.t("status.popover.tab.mcp")}
            </Tabs.Trigger>
            <Tabs.Trigger value="lsp" data-slot="tab" class="text-12-regular">
              <Show when={lspSeverity()}>
                <span class="size-1.5 rounded-full shrink-0 bg-icon-critical-base inline-block mr-1.5" />
              </Show>
              {lspCount() > 0 ? `${lspCount()} ` : ""}
              {language.t("status.popover.tab.lsp")}
            </Tabs.Trigger>
            <Tabs.Trigger value="plugins" data-slot="tab" class="text-12-regular">
              {pluginCount() > 0 ? `${pluginCount()} ` : ""}
              {language.t("status.popover.tab.plugins")}
            </Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value="servers">
            <div class="flex flex-col px-2 pb-2">
              <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
                <div class="flex items-center gap-2 w-full h-8 pl-3 pr-1.5 py-1.5">
                  <div
                    classList={{
                      "size-1.5 rounded-full shrink-0": true,
                      "bg-icon-success-base": server.status() === "live",
                      "bg-icon-warning-base": server.status() === "stale",
                      "bg-icon-critical-base": server.status() === "down",
                      "bg-border-weak-base": server.status() === undefined,
                    }}
                  />
                  <span class="text-14-regular text-text-base truncate">{machineName()}</span>
                  <Show when={server.version}>
                    <span class="text-12-regular text-text-weak truncate">{server.version}</span>
                  </Show>
                </div>
              </div>
            </div>
          </Tabs.Content>

          <Tabs.Content value="mcp">
            <div class="flex flex-col px-2 pb-2">
              <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
                <Show
                  when={mcpItems().length > 0}
                  fallback={
                    <div class="text-14-regular text-text-base text-center my-auto">
                      {language.t("dialog.mcp.empty")}
                    </div>
                  }
                >
                  <For each={mcpItems()}>
                    {(item) => (
                      <div class="flex items-center gap-2 w-full h-8 pl-3 pr-2 py-1 rounded-md text-left">
                        <div
                          classList={{
                            "size-1.5 rounded-full shrink-0": true,
                            "bg-icon-success-base": item.status === "connected",
                            "bg-icon-critical-base": item.status === "failed",
                            "bg-border-weak-base": item.status === "disabled",
                            "bg-icon-warning-base":
                              item.status === "needs_auth" || item.status === "needs_client_registration",
                          }}
                        />
                        <span class="text-14-regular text-text-base truncate flex-1">{item.name}</span>
                        <span class="text-11-regular text-text-weaker">
                          {language.t(`mcp.status.${item.status ?? "disabled"}`)}
                        </span>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </div>
          </Tabs.Content>

          <Tabs.Content value="lsp">
            <div class="flex flex-col px-2 pb-2">
              <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
                <Show
                  when={lspItems().length > 0}
                  fallback={
                    <div class="text-14-regular text-text-base text-center my-auto">
                      {language.t("dialog.lsp.empty")}
                    </div>
                  }
                >
                  <For each={lspItems()}>
                    {(item) => (
                      <div class="flex items-center gap-2 w-full px-2 py-1">
                        <div
                          classList={{
                            "size-1.5 rounded-full shrink-0": true,
                            "bg-icon-success-base": item.status === "connected",
                            "bg-icon-critical-base": item.status === "error",
                          }}
                        />
                        <span class="text-14-regular text-text-base truncate">{item.name || item.id}</span>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </div>
          </Tabs.Content>

          <Tabs.Content value="plugins">
            <div class="flex flex-col px-2 pb-2">
              <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
                <Show
                  when={plugins().length > 0}
                  fallback={
                    <div class="text-14-regular text-text-base text-center my-auto">
                      {(() => {
                        const value = language.t("dialog.plugins.empty")
                        const file = "opencode.json"
                        const parts = value.split(file)
                        if (parts.length === 1) return value
                        return (
                          <>
                            {parts[0]}
                            <code class="bg-surface-raised-base px-1.5 py-0.5 rounded-sm text-text-base">{file}</code>
                            {parts.slice(1).join(file)}
                          </>
                        )
                      })()}
                    </div>
                  }
                >
                  <For each={plugins()}>
                    {(plugin) => (
                      <div class="flex items-center gap-2 w-full px-2 py-1">
                        <div class="size-1.5 rounded-full shrink-0 bg-icon-success-base" />
                        <span class="text-14-regular text-text-base truncate">{plugin}</span>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </div>
          </Tabs.Content>
        </Tabs>
      </div>
    </Popover>
  )
}
