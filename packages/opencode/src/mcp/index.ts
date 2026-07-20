import { dynamicTool, type Tool, jsonSchema, type JSONSchema7 } from "ai"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { BunStdioTransport } from "./stdio"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import {
  CallToolResultSchema,
  type Tool as MCPToolDef,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { Config } from "../config/config"
import { Log } from "../util/log"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod/v4"
import { Instance } from "../project/instance"
import { Installation } from "../installation"
import { withTimeout } from "@/util/timeout"
import { McpOAuthProvider } from "./oauth-provider"
import { McpOAuthCallback } from "./oauth-callback"
import { McpAuth } from "./auth"
import { BusEvent } from "../bus/bus-event"
import { Bus } from "@/bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import open from "open"

export namespace MCP {
  const log = Log.create({ service: "mcp" })
  const DEFAULT_TIMEOUT = 30_000

  async function readStderr(transport: BunStdioTransport, key: string) {
    const stream = transport.stderr
    if (!stream) return
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        log.info(`mcp stderr: ${decoder.decode(value, { stream: true })}`, { key })
      }
    } catch {
    } finally {
      reader.releaseLock()
    }
  }

  export const Resource = z
    .object({
      name: z.string(),
      uri: z.string(),
      description: z.string().optional(),
      mimeType: z.string().optional(),
      client: z.string(),
    })
    .meta({ ref: "McpResource" })
  export type Resource = z.infer<typeof Resource>

  export const ToolsChanged = BusEvent.define(
    "mcp.tools.changed",
    z.object({
      server: z.string(),
    }),
  )

  export const BrowserOpenFailed = BusEvent.define(
    "mcp.browser.open.failed",
    z.object({
      mcpName: z.string(),
      url: z.string(),
    }),
  )

  export const Failed = NamedError.create(
    "MCPFailed",
    z.object({
      name: z.string(),
    }),
  )

  type MCPClient = Client

  export const Status = z
    .discriminatedUnion("status", [
      z
        .object({
          status: z.literal("connected"),
        })
        .meta({
          ref: "MCPStatusConnected",
        }),
      z
        .object({
          status: z.literal("disabled"),
        })
        .meta({
          ref: "MCPStatusDisabled",
        }),
      z
        .object({
          status: z.literal("failed"),
          error: z.string(),
        })
        .meta({
          ref: "MCPStatusFailed",
        }),
      z
        .object({
          status: z.literal("needs_auth"),
        })
        .meta({
          ref: "MCPStatusNeedsAuth",
        }),
      z
        .object({
          status: z.literal("needs_client_registration"),
          error: z.string(),
        })
        .meta({
          ref: "MCPStatusNeedsClientRegistration",
        }),
    ])
    .meta({
      ref: "MCPStatus",
    })
  export type Status = z.infer<typeof Status>

  // Register notification handlers for MCP client
  function registerNotificationHandlers(client: MCPClient, serverName: string) {
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      log.info("tools list changed notification received", { server: serverName })
      Bus.publish(ToolsChanged, { server: serverName })
    })
  }

  // Coerce a single value toward the JSON-schema type. When the model calls an
  // MCP tool from the catalog without its full schema in view, it often emits
  // stringly-typed args ("17" instead of 17, "true" instead of true). The MCP
  // server then rejects them on its own validation.
  // We DO hold the real schema here, so coerce string-encoded primitives back to
  // the declared type before the call. Non-string values and unknown types pass
  // through untouched.
  function coerceValue(value: unknown, schema: JSONSchema7 | undefined): unknown {
    if (!schema || typeof schema !== "object") return value
    const type = Array.isArray(schema.type) ? schema.type[0] : schema.type

    if ((type === "number" || type === "integer") && typeof value === "string" && value.trim() !== "") {
      const n = Number(value)
      if (!Number.isNaN(n)) return type === "integer" ? Math.trunc(n) : n
    }
    if (type === "boolean" && typeof value === "string") {
      if (value === "true") return true
      if (value === "false") return false
    }
    if (type === "object" && value && typeof value === "object" && schema.properties) {
      return coerceArgs(value as Record<string, unknown>, schema)
    }
    if (type === "array" && Array.isArray(value) && schema.items && typeof schema.items === "object") {
      const items = schema.items as JSONSchema7
      return value.map((v) => coerceValue(v, items))
    }
    return value
  }

  export function coerceArgs(args: Record<string, unknown>, schema: JSONSchema7): Record<string, unknown> {
    const props = schema.properties
    if (!props) return args
    const out: Record<string, unknown> = { ...args }
    for (const [key, value] of Object.entries(args)) {
      const propSchema = props[key]
      if (propSchema && typeof propSchema === "object") out[key] = coerceValue(value, propSchema as JSONSchema7)
    }
    return out
  }

  // Convert MCP tool definition to AI SDK Tool type
  async function convertMcpTool(mcpTool: MCPToolDef, client: MCPClient, timeout?: number): Promise<Tool> {
    const inputSchema = mcpTool.inputSchema

    // Spread first, then override type to ensure it's always "object"
    const schema: JSONSchema7 = {
      ...(inputSchema as JSONSchema7),
      type: "object",
      properties: (inputSchema.properties ?? {}) as JSONSchema7["properties"],
      additionalProperties: false,
    }

    return dynamicTool({
      description: mcpTool.description ?? "",
      inputSchema: jsonSchema(schema),
      execute: async (args: unknown) => {
        const coerced = args && typeof args === "object" ? coerceArgs(args as Record<string, unknown>, schema) : args
        return client.callTool(
          {
            name: mcpTool.name,
            arguments: (coerced || {}) as Record<string, unknown>,
          },
          CallToolResultSchema,
          {
            resetTimeoutOnProgress: true,
            timeout,
          },
        )
      },
    })
  }

  // Store transports for OAuth servers to allow finishing auth
  type TransportWithAuth = StreamableHTTPClientTransport | SSEClientTransport
  const pendingOAuthTransports = new Map<string, TransportWithAuth>()

  // Prompt cache types
  type PromptInfo = Awaited<ReturnType<MCPClient["listPrompts"]>>["prompts"][number]

  type ResourceInfo = Awaited<ReturnType<MCPClient["listResources"]>>["resources"][number]
  type McpEntry = NonNullable<Config.Info["mcp"]>[string]
  function isMcpConfigured(entry: McpEntry): entry is Config.Mcp {
    return typeof entry === "object" && entry !== null && "type" in entry
  }

  // Tools cache: per-client snapshot of listTools() taken once when the client
  // is created. tools() serves from this cache for the lifetime of the OpenCode
  // instance — never re-calls listTools(). This keeps the tool catalog stable
  // through transient MCP failures (token blips, network blips, server
  // restarts); the cost is that tool catalog changes mid-session (servers
  // adding/removing tools) require an OpenCode restart to pick up. Acceptable
  // tradeoff for stability.
  type ToolsListResult = Awaited<ReturnType<MCPClient["listTools"]>>

  const state = Instance.state(
    async () => {
      const cfg = await Config.get()
      const config = cfg.mcp ?? {}
      const clients: Record<string, MCPClient> = {}
      const status: Record<string, Status> = {}
      const tools: Record<string, ToolsListResult> = {}

      await Promise.all(
        Object.entries(config).map(async ([key, mcp]) => {
          if (!isMcpConfigured(mcp)) {
            log.error("Ignoring MCP config entry without type", { key })
            return
          }

          // If disabled by config, mark as disabled without trying to connect
          if (mcp.enabled === false) {
            status[key] = { status: "disabled" }
            return
          }

          const result = await create(key, mcp).catch(() => undefined)
          if (!result) return

          status[key] = result.status

          if (result.mcpClient) {
            clients[key] = result.mcpClient
            if (result.tools) tools[key] = result.tools
          }
        }),
      )
      return {
        status,
        clients,
        tools,
      }
    },
    async (state) => {
      await Promise.all(
        Object.values(state.clients).map((client) =>
          client.close().catch((error) => {
            log.error("Failed to close MCP client", {
              error,
            })
          }),
        ),
      )
      pendingOAuthTransports.clear()
    },
  )

  // Close the current MCP clients and drop the memo so the next read rebuilds
  // from fresh config (reconnecting servers, applying add/remove). Called from
  // SessionPin.reset on Stop->reopen: unlike a bare state.reset() (which only
  // evicts the memo and would orphan the live stdio subprocesses / HTTP
  // connections), this closes them first, then rebuilds lazily on next access.
  export async function reset() {
    const s = await state()
    await Promise.all(
      Object.values(s.clients).map((client) =>
        client.close().catch((error) => log.error("Failed to close MCP client", { error })),
      ),
    )
    pendingOAuthTransports.clear()
    state.reset()
  }

  // Helper function to fetch prompts for a specific client
  async function fetchPromptsForClient(clientName: string, client: Client) {
    const prompts = await client.listPrompts().catch((e) => {
      log.error("failed to get prompts", { clientName, error: e.message })
      return undefined
    })

    if (!prompts) {
      return
    }

    const commands: Record<string, PromptInfo & { client: string }> = {}

    for (const prompt of prompts.prompts) {
      const sanitizedClientName = clientName.replace(/[^a-zA-Z0-9_-]/g, "_")
      const sanitizedPromptName = prompt.name.replace(/[^a-zA-Z0-9_-]/g, "_")
      const key = sanitizedClientName + ":" + sanitizedPromptName

      commands[key] = { ...prompt, client: clientName }
    }
    return commands
  }

  async function fetchResourcesForClient(clientName: string, client: Client) {
    const resources = await client.listResources().catch((e) => {
      log.error("failed to get prompts", { clientName, error: e.message })
      return undefined
    })

    if (!resources) {
      return
    }

    const commands: Record<string, ResourceInfo & { client: string }> = {}

    for (const resource of resources.resources) {
      const sanitizedClientName = clientName.replace(/[^a-zA-Z0-9_-]/g, "_")
      const sanitizedResourceName = resource.name.replace(/[^a-zA-Z0-9_-]/g, "_")
      const key = sanitizedClientName + ":" + sanitizedResourceName

      commands[key] = { ...resource, client: clientName }
    }
    return commands
  }

  export async function add(name: string, mcp: Config.Mcp) {
    // The UI writes the server to global config, then calls this. That global
    // write cannot reset THIS instance's config cache (it runs in a context-less
    // global route), so drop the cache here — we ARE in an instance context —
    // so the subsequent status()/corpus() reads (which key off Config.get(), the
    // single source of truth) see the just-written server instead of stale config.
    Config.state.reset()
    const s = await state()
    const result = await create(name, mcp)
    if (!result) {
      const status = {
        status: "failed" as const,
        error: "unknown error",
      }
      s.status[name] = status
      return {
        status,
      }
    }
    if (!result.mcpClient) {
      s.status[name] = result.status
      return {
        status: s.status,
      }
    }
    // Close existing client if present to prevent memory leaks
    const existingClient = s.clients[name]
    if (existingClient) {
      await existingClient.close().catch((error) => {
        log.error("Failed to close existing MCP client", { name, error })
      })
    }
    s.clients[name] = result.mcpClient
    s.status[name] = result.status
    if (result.tools) {
      s.tools[name] = result.tools
    } else {
      delete s.tools[name]
    }

    // Tell every connected client to refetch MCP status so their server list and
    // the dock MCP chip update live, without a page reload.
    Bus.publish(ToolsChanged, { server: name })

    return {
      status: s.status,
    }
  }

  async function create(key: string, mcp: Config.Mcp) {
    if (mcp.enabled === false) {
      log.info("mcp server disabled", { key })
      return {
        mcpClient: undefined,
        status: { status: "disabled" as const },
      }
    }

    log.info("found", { key, type: mcp.type })
    let mcpClient: MCPClient | undefined
    let status: Status | undefined = undefined

    if (mcp.type === "remote") {
      // OAuth is enabled by default for remote servers unless explicitly disabled with oauth: false
      const oauthDisabled = mcp.oauth === false
      const oauthConfig = typeof mcp.oauth === "object" ? mcp.oauth : undefined
      let authProvider: McpOAuthProvider | undefined

      if (!oauthDisabled) {
        const cfg = await Config.get()
        authProvider = new McpOAuthProvider(
          key,
          mcp.url,
          {
            clientId: oauthConfig?.clientId,
            clientSecret: oauthConfig?.clientSecret,
            scope: oauthConfig?.scope,
          },
          {
            onRedirect: async (url) => {
              log.info("oauth redirect requested", { key, url: url.toString() })
              // Store the URL - actual browser opening is handled by startAuth
            },
          },
          cfg.experimental?.mcp_oauth_port,
          cfg.experimental?.mcp_oauth_path,
        )
      }

      const transports: Array<{ name: string; transport: TransportWithAuth }> = [
        {
          name: "StreamableHTTP",
          transport: new StreamableHTTPClientTransport(new URL(mcp.url), {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
          }),
        },
        {
          name: "SSE",
          transport: new SSEClientTransport(new URL(mcp.url), {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
          }),
        },
      ]

      let lastError: Error | undefined
      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      for (const { name, transport } of transports) {
        try {
          const client = new Client({
            name: "opencode",
            version: Installation.VERSION,
          })
          await withTimeout(client.connect(transport), connectTimeout)
          registerNotificationHandlers(client, key)
          mcpClient = client
          log.info("connected", { key, transport: name })
          status = { status: "connected" }
          break
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))

          // Handle OAuth-specific errors
          if (error instanceof UnauthorizedError) {
            log.info("mcp server requires authentication", { key, transport: name })

            // Check if this is a "needs registration" error
            if (lastError.message.includes("registration") || lastError.message.includes("client_id")) {
              status = {
                status: "needs_client_registration" as const,
                error: "Server does not support dynamic client registration. Please provide clientId in config.",
              }
              // Show toast for needs_client_registration
              Bus.publish(TuiEvent.ToastShow, {
                title: "MCP Authentication Required",
                message: `Server "${key}" requires a pre-registered client ID. Add clientId to your config.`,
                variant: "warning",
                duration: 8000,
              }).catch((e) => log.debug("failed to show toast", { error: e }))
            } else {
              // Store transport for later finishAuth call
              pendingOAuthTransports.set(key, transport)
              status = { status: "needs_auth" as const }
              // Show toast for needs_auth
              Bus.publish(TuiEvent.ToastShow, {
                title: "MCP Authentication Required",
                message: `Server "${key}" requires authentication. Run: opencode mcp auth ${key}`,
                variant: "warning",
                duration: 8000,
              }).catch((e) => log.debug("failed to show toast", { error: e }))
            }
            break
          }

          log.debug("transport connection failed", {
            key,
            transport: name,
            url: mcp.url,
            error: lastError.message,
          })
          status = {
            status: "failed" as const,
            error: lastError.message,
          }
        }
      }
    }

    if (mcp.type === "local") {
      const [cmd, ...args] = mcp.command
      const cwd = Instance.directory
      const transport = new BunStdioTransport({
        command: cmd,
        args,
        cwd,
        env: {
          ...process.env,
          ...(cmd === "opencode" ? { BUN_BE_BUN: "1" } : {}),
          ...mcp.environment,
        },
      })
      readStderr(transport, key)

      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      try {
        const client = new Client({
          name: "opencode",
          version: Installation.VERSION,
        })
        await withTimeout(client.connect(transport), connectTimeout)
        registerNotificationHandlers(client, key)
        mcpClient = client
        status = {
          status: "connected",
        }
      } catch (error) {
        log.error("local mcp startup failed", {
          key,
          command: mcp.command,
          cwd,
          error: error instanceof Error ? error.message : String(error),
        })
        status = {
          status: "failed" as const,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }

    if (!status) {
      status = {
        status: "failed" as const,
        error: "Unknown error",
      }
    }

    if (!mcpClient) {
      return {
        mcpClient: undefined,
        status,
      }
    }

    const result = await withTimeout(mcpClient.listTools(), mcp.timeout ?? DEFAULT_TIMEOUT).catch((err) => {
      log.error("failed to get tools from client", { key, error: err })
      return undefined
    })
    if (!result) {
      await mcpClient.close().catch((error) => {
        log.error("Failed to close MCP client", {
          error,
        })
      })
      status = {
        status: "failed",
        error: "Failed to get tools",
      }
      return {
        mcpClient: undefined,
        status: {
          status: "failed" as const,
          error: "Failed to get tools",
        },
      }
    }

    log.info("create() successfully created client", { key, toolCount: result.tools.length })
    return {
      mcpClient,
      status,
      tools: result,
    }
  }

  export async function status() {
    const s = await state()
    const cfg = await Config.get()
    const config = cfg.mcp ?? {}
    const result: Record<string, Status> = {}

    // Config is the SINGLE source of truth for which servers exist. Live status
    // (s.status) only supplies the runtime state of a configured server; it never
    // invents a server that config does not list.
    for (const [key, mcp] of Object.entries(config)) {
      if (!isMcpConfigured(mcp)) continue
      result[key] = s.status[key] ?? { status: "disabled" }
    }

    return result
  }

  export async function clients() {
    return state().then((state) => state.clients)
  }

  export async function connect(name: string) {
    const cfg = await Config.get()
    const config = cfg.mcp ?? {}
    const mcp = config[name]
    if (!mcp) {
      log.error("MCP config not found", { name })
      return
    }

    if (!isMcpConfigured(mcp)) {
      log.error("Ignoring MCP connect request for config without type", { name })
      return
    }

    const result = await create(name, { ...mcp, enabled: true })

    if (!result) {
      const s = await state()
      s.status[name] = {
        status: "failed",
        error: "Unknown error during connection",
      }
      return
    }

    const s = await state()
    s.status[name] = result.status
    if (result.mcpClient) {
      // Close existing client if present to prevent memory leaks
      const existingClient = s.clients[name]
      if (existingClient) {
        await existingClient.close().catch((error) => {
          log.error("Failed to close existing MCP client", { name, error })
        })
      }
      s.clients[name] = result.mcpClient
      if (result.tools) {
        s.tools[name] = result.tools
      } else {
        delete s.tools[name]
      }
    }
    Bus.publish(ToolsChanged, { server: name })
  }

  export async function disconnect(name: string) {
    const s = await state()
    const client = s.clients[name]
    if (client) {
      await client.close().catch((error) => {
        log.error("Failed to close MCP client", { name, error })
      })
      delete s.clients[name]
    }
    delete s.tools[name]
    s.status[name] = { status: "disabled" }
    Bus.publish(ToolsChanged, { server: name })
  }

  // Derive the globally-unique tool key exposed to the model
  // (sanitizedClientName + "_" + sanitizedToolName), stripping a leading copy
  // of the client name when the server self-namespaces its tools. This is the
  // single source of truth for the key so the executable tool map (tools()),
  // the raw catalog corpus (corpus()), and the on/off gate all agree.
  //
  // Many MCP servers self-namespace their tools with the server name
  // (datadog -> "datadog_aggregate_logs", notion -> "notion-search"). When the
  // config key matches that self-prefix, composing clientName + "_" + toolName
  // double-prefixes ("datadog_datadog_aggregate_logs"). Strip a leading copy of
  // the client name plus its "_"/"-" separator. The separator check keeps a
  // short key (e.g. "note") from mangling an unrelated tool ("notebook_create").
  export function toolKey(clientName: string, toolName: string) {
    const sanitizedClientName = clientName.replace(/[^a-zA-Z0-9_-]/g, "_")
    const deduped =
      toolName.startsWith(clientName + "_") || toolName.startsWith(clientName + "-")
        ? toolName.slice(clientName.length + 1)
        : toolName
    const sanitizedToolName = deduped.replace(/[^a-zA-Z0-9_-]/g, "_")
    return sanitizedClientName + "_" + sanitizedToolName
  }

  // Live advertised-tools fetch for a single server (the UI "refresh advertised
  // tools" source and the whitelist-curation substrate). Connects if needed;
  // when the server needs auth/registration it surfaces that status instead of
  // triggering interactive OAuth. On success it refreshes the per-client tools
  // cache and returns the advertised list.
  export async function listLive(name: string): Promise<{ status: Status; tools: MCPToolDef[] }> {
    const s = await state()
    if (!s.clients[name] || s.status[name]?.status !== "connected") {
      await connect(name)
    }
    const status = s.status[name] ?? { status: "disabled" as const }
    const client = s.clients[name]
    if (!client || status.status !== "connected") {
      return { status, tools: [] }
    }
    const cfg = await Config.get()
    const mcp = cfg.mcp?.[name]
    const timeout = (mcp && isMcpConfigured(mcp) ? mcp.timeout : undefined) ?? DEFAULT_TIMEOUT
    const result = await withTimeout(client.listTools(), timeout).catch((err) => {
      log.error("listLive failed to get tools", { name, error: err })
      return undefined
    })
    if (!result) return { status, tools: [] }
    s.tools[name] = result
    return { status, tools: result.tools }
  }

  // Raw metadata for every whitelisted MCP tool, keyed identically to tools().
  // Unlike tools() (which returns executable AI-SDK tools with opaque wrapped
  // schemas), corpus() returns the plain name/description/JSON-schema plus the
  // owning client and its configured catalog tier. This is the substrate the
  // mcp_search tool searches and the progressive-disclosure catalog is built
  // from. Every tool a connected server advertises is included by default; a
  // name listed in the server's `disabled` config is dropped (desc/schema are
  // hydrated from the live/cached tools list). `disabled` is read from the
  // merged config, so a project override can hide a different set than global.
  export type CorpusEntry = {
    key: string
    client: string
    tier: Config.McpTier
    name: string
    description: string
    schema: unknown
  }
  export async function corpus(): Promise<CorpusEntry[]> {
    const result: CorpusEntry[] = []
    const s = await state()
    const cfg = await Config.get()
    const config = cfg.mcp ?? {}
    const clientsSnapshot = await clients()

    for (const clientName of Object.keys(clientsSnapshot)) {
      if (s.status[clientName]?.status !== "connected") continue
      const toolsResult = s.tools[clientName]
      if (!toolsResult) continue
      const mcpConfig = config[clientName]
      const entry = isMcpConfigured(mcpConfig) ? mcpConfig : undefined
      const tier = entry?.tier ?? "name"
      const disabled = new Set(entry?.disabled ?? [])
      for (const mcpTool of toolsResult.tools) {
        if (disabled.has(mcpTool.name)) continue
        result.push({
          key: toolKey(clientName, mcpTool.name),
          client: clientName,
          tier,
          name: mcpTool.name,
          description: mcpTool.description ?? "",
          schema: mcpTool.inputSchema,
        })
      }
    }
    return result
  }

  // Whether an executable tool key is denied by config. The catalog gate
  // (corpus, above) and the execution gate must agree, so both consult the
  // server's `disabled` list — corpus by native name pre-toolKey, this by the
  // derived toolKey the model actually calls. Returns true when the tool's
  // server lists its native name in `disabled`.
  export async function isDisabled(key: string): Promise<boolean> {
    const cfg = await Config.get()
    const config = cfg.mcp ?? {}
    for (const [clientName, mcpConfig] of Object.entries(config)) {
      if (!isMcpConfigured(mcpConfig)) continue
      const disabled = mcpConfig.disabled
      if (!disabled?.length) continue
      for (const name of disabled) if (toolKey(clientName, name) === key) return true
    }
    return false
  }

  export async function tools() {
    // Serve from the per-client tools cache populated at create() time.
    // We deliberately do NOT call client.listTools() here — that caused MCP
    // servers to disappear from the catalog on any transient failure
    // (token rotation, network blip, server restart, timeout). The cached
    // list stays valid for the lifetime of the OpenCode instance.
    //
    // Every connected tool is registered here regardless of `disabled`: this map
    // is the executable substrate. A `disabled` tool is both hidden from the
    // catalog (corpus) and denied at the execute gate (SessionPrompt.mcpDenied ->
    // MCP.isDisabled), so it never runs even though it is registered. Registering
    // uniformly keeps tools[] byte-stable on the wire; the deny is a runtime guard.
    const result: Record<string, Tool> = {}
    const s = await state()
    const cfg = await Config.get()
    const config = cfg.mcp ?? {}
    const clientsSnapshot = await clients()
    const defaultTimeout = cfg.experimental?.mcp_timeout

    for (const [clientName, client] of Object.entries(clientsSnapshot)) {
      // Only include tools from connected MCPs (skip disabled ones)
      if (s.status[clientName]?.status !== "connected") {
        continue
      }

      const toolsResult = s.tools[clientName]
      if (!toolsResult) {
        // No cached tools for this client — this is unexpected because
        // create() returns tools on success. Skip rather than crash.
        log.error("no cached tools for connected client", { clientName })
        continue
      }
      const mcpConfig = config[clientName]
      const entry = isMcpConfigured(mcpConfig) ? mcpConfig : undefined
      const timeout = entry?.timeout ?? defaultTimeout
      for (const mcpTool of toolsResult.tools) {
        result[toolKey(clientName, mcpTool.name)] = await convertMcpTool(mcpTool, client, timeout)
      }
    }
    return result
  }

  export async function prompts() {
    const s = await state()
    const clientsSnapshot = await clients()

    const prompts = Object.fromEntries<PromptInfo & { client: string }>(
      (
        await Promise.all(
          Object.entries(clientsSnapshot).map(async ([clientName, client]) => {
            if (s.status[clientName]?.status !== "connected") {
              return []
            }

            return Object.entries((await fetchPromptsForClient(clientName, client)) ?? {})
          }),
        )
      ).flat(),
    )

    return prompts
  }

  export async function resources() {
    const s = await state()
    const clientsSnapshot = await clients()

    const result = Object.fromEntries<ResourceInfo & { client: string }>(
      (
        await Promise.all(
          Object.entries(clientsSnapshot).map(async ([clientName, client]) => {
            if (s.status[clientName]?.status !== "connected") {
              return []
            }

            return Object.entries((await fetchResourcesForClient(clientName, client)) ?? {})
          }),
        )
      ).flat(),
    )

    return result
  }

  export async function getPrompt(clientName: string, name: string, args?: Record<string, string>) {
    const clientsSnapshot = await clients()
    const client = clientsSnapshot[clientName]

    if (!client) {
      log.warn("client not found for prompt", {
        clientName,
      })
      return undefined
    }

    const result = await client
      .getPrompt({
        name: name,
        arguments: args,
      })
      .catch((e) => {
        log.error("failed to get prompt from MCP server", {
          clientName,
          promptName: name,
          error: e.message,
        })
        return undefined
      })

    return result
  }

  export async function readResource(clientName: string, resourceUri: string) {
    const clientsSnapshot = await clients()
    const client = clientsSnapshot[clientName]

    if (!client) {
      log.warn("client not found for prompt", {
        clientName: clientName,
      })
      return undefined
    }

    const result = await client
      .readResource({
        uri: resourceUri,
      })
      .catch((e) => {
        log.error("failed to get prompt from MCP server", {
          clientName: clientName,
          resourceUri: resourceUri,
          error: e.message,
        })
        return undefined
      })

    return result
  }

  /**
   * Start OAuth authentication flow for an MCP server.
   * Returns the authorization URL that should be opened in a browser.
   */
  export async function startAuth(mcpName: string): Promise<{ authorizationUrl: string }> {
    const cfg = await Config.get()
    const mcpConfig = cfg.mcp?.[mcpName]

    if (!mcpConfig) {
      throw new Error(`MCP server not found: ${mcpName}`)
    }

    if (!isMcpConfigured(mcpConfig)) {
      throw new Error(`MCP server ${mcpName} is disabled or missing configuration`)
    }

    if (mcpConfig.type !== "remote") {
      throw new Error(`MCP server ${mcpName} is not a remote server`)
    }

    if (mcpConfig.oauth === false) {
      throw new Error(`MCP server ${mcpName} has OAuth explicitly disabled`)
    }

    // Create a new auth provider for this flow
    // OAuth config is optional - if not provided, we'll use auto-discovery
    const oauthConfig = typeof mcpConfig.oauth === "object" ? mcpConfig.oauth : undefined
    let capturedUrl: URL | undefined
    const authProvider = new McpOAuthProvider(
      mcpName,
      mcpConfig.url,
      {
        clientId: oauthConfig?.clientId,
        clientSecret: oauthConfig?.clientSecret,
        scope: oauthConfig?.scope,
      },
      {
        onRedirect: async (url) => {
          capturedUrl = url
        },
      },
      cfg.experimental?.mcp_oauth_port,
      cfg.experimental?.mcp_oauth_path,
    )

    // Start the callback server on the provider's configured port/path
    await McpOAuthCallback.ensureRunning(authProvider.callbackPort, authProvider.callbackPath)

    // Generate and store a cryptographically secure state parameter BEFORE creating the provider
    // The SDK will call provider.state() to read this value
    const oauthState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
    await McpAuth.updateOAuthState(mcpName, oauthState)

    // Create transport with auth provider
    const transport = new StreamableHTTPClientTransport(new URL(mcpConfig.url), {
      authProvider,
    })

    // Try to connect - this will trigger the OAuth flow
    try {
      const client = new Client({
        name: "opencode",
        version: Installation.VERSION,
      })
      await client.connect(transport)
      // If we get here, we're already authenticated
      return { authorizationUrl: "" }
    } catch (error) {
      if (error instanceof UnauthorizedError && capturedUrl) {
        // Store transport for finishAuth
        pendingOAuthTransports.set(mcpName, transport)
        return { authorizationUrl: capturedUrl.toString() }
      }
      throw error
    }
  }

  /**
   * Detect a headless/remote session where launching a local browser will
   * either fail silently or succeed uselessly. In these cases the caller
   * should surface the auth URL for the user to open on a machine that has
   * a browser (typically reaching the callback server via SSH port-forward).
   */
  function isHeadless(): boolean {
    const env = process.env
    if (env["SSH_TTY"] || env["SSH_CONNECTION"] || env["SSH_CLIENT"]) return true
    // Linux GUI sessions set DISPLAY or WAYLAND_DISPLAY. Absence on Linux
    // strongly implies no browser. macOS has no such var, so don't infer from it.
    if (process.platform === "linux" && !env["DISPLAY"] && !env["WAYLAND_DISPLAY"]) return true
    return false
  }

  /**
   * Complete OAuth authentication after user authorizes in browser.
   * Opens the browser and waits for callback.
   */
  export async function authenticate(mcpName: string): Promise<Status> {
    const { authorizationUrl } = await startAuth(mcpName)

    if (!authorizationUrl) {
      // Already authenticated
      const s = await state()
      return s.status[mcpName] ?? { status: "connected" }
    }

    // Get the state that was already generated and stored in startAuth()
    const oauthState = await McpAuth.getOAuthState(mcpName)
    if (!oauthState) {
      throw new Error("OAuth state not found - this should not happen")
    }

    // The SDK has already added the state parameter to the authorization URL
    // We just need to open the browser
    log.info("opening browser for oauth", { mcpName, url: authorizationUrl, state: oauthState })

    // Register the callback BEFORE opening the browser to avoid race condition
    // when the IdP has an active SSO session and redirects immediately
    const callbackPromise = McpOAuthCallback.waitForCallback(oauthState)

    if (isHeadless()) {
      // Remote/headless session (SSH, devcontainer, etc). Don't try to open a
      // browser on this machine — there isn't one, or worse, open() exits 0
      // with no display and we hang forever. Surface the URL so the user can
      // open it on a machine that has a browser and reach the callback via
      // port forwarding.
      log.info("headless session detected, skipping browser open", { mcpName })
      Bus.publish(BrowserOpenFailed, { mcpName, url: authorizationUrl })
    } else {
      try {
        const subprocess = await open(authorizationUrl)
        // The open package spawns a detached process and returns immediately.
        // We need to listen for errors which fire asynchronously:
        // - "error" event: command not found (ENOENT)
        // - "exit" with non-zero code: command exists but failed (e.g., no display)
        await new Promise<void>((resolve, reject) => {
          // Give the process a moment to fail if it's going to
          const timeout = setTimeout(() => resolve(), 500)
          subprocess.on("error", (error) => {
            clearTimeout(timeout)
            reject(error)
          })
          subprocess.on("exit", (code) => {
            if (code !== null && code !== 0) {
              clearTimeout(timeout)
              reject(new Error(`Browser open failed with exit code ${code}`))
            }
          })
        })
      } catch (error) {
        // Browser opening failed (e.g., in remote/headless sessions like SSH, devcontainers)
        // Emit event so CLI can display the URL for manual opening
        log.warn("failed to open browser, user must open URL manually", { mcpName, error })
        Bus.publish(BrowserOpenFailed, { mcpName, url: authorizationUrl })
      }
    }

    // Wait for callback using the already-registered promise
    const code = await callbackPromise

    // Validate and clear the state
    const storedState = await McpAuth.getOAuthState(mcpName)
    if (storedState !== oauthState) {
      await McpAuth.clearOAuthState(mcpName)
      throw new Error("OAuth state mismatch - potential CSRF attack")
    }

    await McpAuth.clearOAuthState(mcpName)

    // Finish auth
    return finishAuth(mcpName, code)
  }

  /**
   * Complete OAuth authentication with the authorization code.
   */
  export async function finishAuth(mcpName: string, authorizationCode: string): Promise<Status> {
    const transport = pendingOAuthTransports.get(mcpName)

    if (!transport) {
      throw new Error(`No pending OAuth flow for MCP server: ${mcpName}`)
    }

    try {
      // Call finishAuth on the transport
      await transport.finishAuth(authorizationCode)

      // Clear the code verifier after successful auth
      await McpAuth.clearCodeVerifier(mcpName)

      // Now try to reconnect
      const cfg = await Config.get()
      const mcpConfig = cfg.mcp?.[mcpName]

      if (!mcpConfig) {
        throw new Error(`MCP server not found: ${mcpName}`)
      }

      if (!isMcpConfigured(mcpConfig)) {
        throw new Error(`MCP server ${mcpName} is disabled or missing configuration`)
      }

      // Re-add the MCP server to establish connection
      pendingOAuthTransports.delete(mcpName)
      const result = await add(mcpName, mcpConfig)

      const statusRecord = result.status as Record<string, Status>
      return statusRecord[mcpName] ?? { status: "failed", error: "Unknown error after auth" }
    } catch (error) {
      log.error("failed to finish oauth", { mcpName, error })
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Remove OAuth credentials for an MCP server.
   */
  export async function removeAuth(mcpName: string): Promise<void> {
    await McpAuth.remove(mcpName)
    McpOAuthCallback.cancelPending(mcpName)
    pendingOAuthTransports.delete(mcpName)
    await McpAuth.clearOAuthState(mcpName)
    log.info("removed oauth credentials", { mcpName })
  }

  /**
   * Check if an MCP server supports OAuth (remote servers support OAuth by default unless explicitly disabled).
   */
  export async function supportsOAuth(mcpName: string): Promise<boolean> {
    const cfg = await Config.get()
    const mcpConfig = cfg.mcp?.[mcpName]
    if (!mcpConfig) return false
    if (!isMcpConfigured(mcpConfig)) return false
    return mcpConfig.type === "remote" && mcpConfig.oauth !== false
  }

  /**
   * Check if an MCP server has stored OAuth tokens.
   */
  export async function hasStoredTokens(mcpName: string): Promise<boolean> {
    const entry = await McpAuth.get(mcpName)
    return !!entry?.tokens
  }

  export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

  /**
   * Get the authentication status for an MCP server.
   */
  export async function getAuthStatus(mcpName: string): Promise<AuthStatus> {
    const hasTokens = await hasStoredTokens(mcpName)
    if (!hasTokens) return "not_authenticated"
    const expired = await McpAuth.isTokenExpired(mcpName)
    return expired ? "expired" : "authenticated"
  }
}
