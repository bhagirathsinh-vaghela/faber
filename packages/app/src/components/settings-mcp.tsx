import { Component, createMemo, createSignal, For, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { McpLocalConfig, McpRemoteConfig, McpStatus } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { Select } from "@opencode-ai/ui/select"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"

type Tier = "name" | "description" | "full"

// A server's config as read from the merged config block. Local servers carry a
// command; remote servers carry a url.
type ServerConfig = McpLocalConfig | McpRemoteConfig

// Advertised tools + whitelist, fetched lazily when a server row is expanded.
type Detail = {
  loading: boolean
  status?: McpStatus
  tools: { name: string; description?: string }[]
  whitelist: string[]
}

const statusDot = (status: McpStatus["status"] | undefined) => {
  if (status === "connected") return "bg-icon-success-base"
  if (status === "failed") return "bg-icon-critical-base"
  if (status === "needs_auth" || status === "needs_client_registration") return "bg-icon-warning-base"
  return "bg-border-weak-base"
}

export const SettingsMcp: Component = () => {
  const language = useLanguage()
  const sync = useSync()
  const sdk = useSDK()
  const globalSync = useGlobalSync()

  const t = language.t

  const statusLabel = (status: McpStatus["status"] | undefined) => {
    if (status === "connected") return t("mcp.status.connected")
    if (status === "failed") return t("mcp.status.failed")
    if (status === "needs_auth") return t("mcp.status.needs_auth")
    if (status === "needs_client_registration") return t("mcp.status.needs_client_registration")
    return t("mcp.status.disabled")
  }

  // Configured servers joined with their live status. Config is the source of
  // truth for what exists; status is the runtime connection state.
  const servers = createMemo(() => {
    const config = (sync.data.config.mcp ?? {}) as Record<string, ServerConfig>
    return Object.keys(config)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, status: sync.data.mcp[name]?.status }))
  })

  const [busy, setBusy] = createSignal<string | null>(null)
  const [expanded, setExpanded] = createSignal<string | null>(null)
  const [detail, setDetail] = createStore<Record<string, Detail>>({})

  const tierOptions: { value: Tier; label: string }[] = [
    { value: "name", label: t("settings.mcp.tier.name") },
    { value: "description", label: t("settings.mcp.tier.description") },
    { value: "full", label: t("settings.mcp.tier.full") },
  ]

  const refreshStatus = async () => {
    const result = await sdk.client.mcp.status()
    if (result.data) sync.set("mcp", result.data)
  }

  const withBusy = async (name: string, fn: () => Promise<void>) => {
    if (busy()) return
    setBusy(name)
    try {
      await fn()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: t("common.requestFailed"), description: message })
    } finally {
      setBusy(null)
    }
  }

  const loadDetail = async (name: string) => {
    setDetail(name, (prev) => ({ ...(prev ?? { tools: [], whitelist: [] }), loading: true }))
    const [tools, whitelist] = await Promise.all([sdk.client.mcp.tools({ name }), sdk.client.mcp.whitelist.get({ name })])
    setDetail(name, {
      loading: false,
      status: tools.data?.status,
      tools: tools.data?.tools ?? [],
      whitelist: whitelist.data ?? [],
    })
    if (tools.data?.status) sync.set("mcp", name, tools.data.status)
  }

  const toggleExpanded = (name: string) => {
    if (expanded() === name) {
      setExpanded(null)
      return
    }
    setExpanded(name)
    if (!detail[name]) void loadDetail(name)
  }

  const connect = (name: string, status: McpStatus["status"] | undefined) =>
    withBusy(name, async () => {
      if (status === "connected") await sdk.client.mcp.disconnect({ name })
      else await sdk.client.mcp.connect({ name })
      await refreshStatus()
    })

  const authenticate = (name: string) =>
    withBusy(name, async () => {
      await sdk.client.mcp.auth.authenticate({ name })
      await refreshStatus()
      if (expanded() === name) await loadDetail(name)
    })

  const refreshTools = (name: string) => withBusy(name, () => loadDetail(name))

  const toggleWhitelist = (name: string, tool: string, checked: boolean) => {
    const current = detail[name]?.whitelist ?? []
    const next = checked ? [...current, tool] : current.filter((x) => x !== tool)
    setDetail(name, "whitelist", next)
    void sdk.client.mcp.whitelist.set({ name, names: next }).catch((err) => {
      // Revert on failure so the checkbox reflects server truth.
      setDetail(name, "whitelist", current)
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: t("common.requestFailed"), description: message })
    })
  }

  // The server route deletes the server from global config, clears its
  // whitelist, and disconnects it — so no client-side config write is needed
  // (config mergeDeep can't delete a key anyway). An empty updateConfig drives
  // the reload cycle so the client re-fetches config without the removed server.
  const remove = (name: string) =>
    withBusy(name, async () => {
      await sdk.client.mcp.remove({ name })
      await globalSync.updateConfig({})
      setDetail(
        produce((draft) => {
          delete draft[name]
        }),
      )
      if (expanded() === name) setExpanded(null)
      await refreshStatus()
    })

  // ---- add-server form ----
  const blankForm = () => ({
    open: false,
    saving: false,
    name: "",
    type: "local" as "local" | "remote",
    command: "",
    url: "",
    tier: "name" as Tier,
    error: undefined as string | undefined,
  })
  const [form, setForm] = createStore(blankForm())

  const submitAdd = async (e: SubmitEvent) => {
    e.preventDefault()
    if (form.saving) return
    const name = form.name.trim()
    if (!name) return setForm("error", t("settings.mcp.add.error.name"))
    if (sync.data.config.mcp?.[name]) return setForm("error", t("settings.mcp.add.error.exists"))

    const config: ServerConfig =
      form.type === "local"
        ? { type: "local", command: form.command.trim().split(/\s+/).filter(Boolean), tier: form.tier }
        : { type: "remote", url: form.url.trim(), tier: form.tier }

    if (form.type === "local" && (config as { command: string[] }).command.length === 0)
      return setForm("error", t("settings.mcp.add.error.command"))
    if (form.type === "remote" && !form.url.trim()) return setForm("error", t("settings.mcp.add.error.url"))

    setForm("saving", true)
    setForm("error", undefined)
    try {
      await globalSync.updateConfig({ mcp: { [name]: config } })
      await sdk.client.mcp.add({ name, config })
      await refreshStatus()
      setForm(blankForm())
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setForm("error", message)
    } finally {
      setForm("saving", false)
    }
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-raised-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex items-center justify-between gap-4 pt-6 pb-8">
          <div class="flex flex-col gap-1">
            <h2 class="text-16-medium text-text-strong">{t("settings.mcp.title")}</h2>
            <p class="text-12-regular text-text-weak">{t("settings.mcp.description")}</p>
          </div>
          <Button
            size="small"
            variant="secondary"
            icon="plus-small"
            onClick={() => setForm("open", (v) => !v)}
            disabled={form.open}
          >
            {t("settings.mcp.add.button")}
          </Button>
        </div>
      </div>

      <div class="flex flex-col gap-8 w-full max-w-[720px]">
        <Show when={form.open}>
          <form onSubmit={submitAdd} class="flex flex-col gap-4 bg-surface-raised-base p-4 rounded-lg">
            <h3 class="text-14-medium text-text-strong">{t("settings.mcp.add.title")}</h3>
            <TextField
              autofocus
              label={t("settings.mcp.add.field.name")}
              placeholder="my-server"
              value={form.name}
              onChange={setForm.bind(null, "name")}
            />
            <div class="flex flex-col gap-1.5">
              <label class="text-12-medium text-text-weak">{t("settings.mcp.add.field.type")}</label>
              <Select
                options={[
                  { value: "local" as const, label: t("settings.mcp.type.local") },
                  { value: "remote" as const, label: t("settings.mcp.type.remote") },
                ]}
                current={{
                  value: form.type,
                  label: form.type === "local" ? t("settings.mcp.type.local") : t("settings.mcp.type.remote"),
                }}
                value={(o) => o.value}
                label={(o) => o.label}
                onSelect={(o) => o && setForm("type", o.value)}
                variant="secondary"
              />
            </div>
            <Show when={form.type === "local"}>
              <TextField
                label={t("settings.mcp.add.field.command")}
                placeholder="npx -y @modelcontextprotocol/server-foo"
                value={form.command}
                onChange={setForm.bind(null, "command")}
              />
            </Show>
            <Show when={form.type === "remote"}>
              <TextField
                label={t("settings.mcp.add.field.url")}
                placeholder="https://mcp.example.com/mcp"
                value={form.url}
                onChange={setForm.bind(null, "url")}
              />
            </Show>
            <div class="flex flex-col gap-1.5">
              <label class="text-12-medium text-text-weak">{t("settings.mcp.tier.label")}</label>
              <Select
                options={tierOptions}
                current={tierOptions.find((o) => o.value === form.tier)}
                value={(o) => o.value}
                label={(o) => o.label}
                onSelect={(o) => o && setForm("tier", o.value)}
                variant="secondary"
              />
            </div>
            <Show when={form.error}>
              <p class="text-12-regular text-text-critical-base">{form.error}</p>
            </Show>
            <div class="flex items-center gap-2">
              <Button type="submit" size="small" variant="primary" disabled={form.saving}>
                {form.saving ? t("common.loading.ellipsis") : t("settings.mcp.add.submit")}
              </Button>
              <Button type="button" size="small" variant="secondary" onClick={() => setForm(blankForm())}>
                {t("common.cancel")}
              </Button>
            </div>
          </form>
        </Show>

        <Show
          when={servers().length > 0}
          fallback={<p class="text-14-regular text-text-weak">{t("settings.mcp.empty")}</p>}
        >
          <div class="flex flex-col gap-2">
            <For each={servers()}>
              {(server) => {
                const d = () => detail[server.name]
                return (
                  <div class="bg-surface-raised-base rounded-lg">
                    <div class="flex items-center justify-between gap-3 px-4 py-3">
                      <button
                        type="button"
                        class="flex items-center gap-2 min-w-0 flex-1 text-left"
                        onClick={() => toggleExpanded(server.name)}
                      >
                        <span class={`size-2 shrink-0 rounded-full ${statusDot(server.status)}`} />
                        <span class="text-14-medium text-text-strong truncate">{server.name}</span>
                        <span class="text-11-regular text-text-weaker">{statusLabel(server.status)}</span>
                      </button>
                      <div class="flex items-center gap-1 shrink-0">
                        <Show when={server.status === "needs_auth" || server.status === "needs_client_registration"}>
                          <Button
                            size="small"
                            variant="secondary"
                            disabled={busy() === server.name}
                            onClick={() => authenticate(server.name)}
                          >
                            {t("settings.mcp.action.auth")}
                          </Button>
                        </Show>
                        <Button
                          size="small"
                          variant="secondary"
                          disabled={busy() === server.name}
                          onClick={() => connect(server.name, server.status)}
                        >
                          {server.status === "connected" ? t("settings.mcp.action.disconnect") : t("settings.mcp.action.connect")}
                        </Button>
                        <IconButton
                          icon="download"
                          variant="ghost"
                          disabled={busy() === server.name}
                          aria-label={t("settings.mcp.action.refresh")}
                          onClick={() => refreshTools(server.name)}
                        />
                        <IconButton
                          icon="trash"
                          variant="ghost"
                          disabled={busy() === server.name}
                          aria-label={t("settings.mcp.action.remove")}
                          onClick={() => remove(server.name)}
                        />
                      </div>
                    </div>

                    <Show when={expanded() === server.name}>
                      <div class="flex flex-col gap-2 px-4 pb-4 border-t border-border-weak-base pt-3">
                        <div class="flex items-center justify-between">
                          <span class="text-12-medium text-text-weak">{t("settings.mcp.whitelist.label")}</span>
                        </div>
                        <p class="text-11-regular text-text-weaker">{t("settings.mcp.whitelist.hint")}</p>
                        <Show when={d()?.loading}>
                          <span class="text-12-regular text-text-weak">{t("common.loading.ellipsis")}</span>
                        </Show>
                        <Show when={!d()?.loading && (d()?.tools.length ?? 0) === 0}>
                          <span class="text-12-regular text-text-weak">{t("settings.mcp.whitelist.none")}</span>
                        </Show>
                        <For each={d()?.tools ?? []}>
                          {(tool) => (
                            <label class="flex items-start gap-2 py-1 cursor-pointer">
                              <Checkbox
                                checked={(d()?.whitelist ?? []).includes(tool.name)}
                                onChange={(checked) => toggleWhitelist(server.name, tool.name, checked)}
                              />
                              <div class="flex flex-col gap-0.5 min-w-0">
                                <span class="text-13-medium text-text-strong truncate">{tool.name}</span>
                                <Show when={tool.description}>
                                  <span class="text-11-regular text-text-weaker line-clamp-2">{tool.description}</span>
                                </Show>
                              </div>
                            </label>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}
