import { Installation } from "@/installation"
import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"
import {
  streamText,
  wrapLanguageModel,
  type ModelMessage,
  type StreamTextResult,
  type Tool,
  type ToolSet,
  tool,
  jsonSchema,
} from "ai"
import { createHash } from "crypto"
import { clone, mergeDeep, pipe } from "remeda"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import type { Agent } from "@/agent/agent"
import { MessageV2 } from "./message-v2"
import { Session } from "."
import { Plugin } from "@/plugin"
import { SystemPrompt } from "./system"
import { Flag } from "@/flag/flag"
import { Auth } from "@/auth"

export namespace LLM {
  const log = Log.create({ service: "llm" })

  export const OUTPUT_TOKEN_MAX = Flag.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX || 32_000

  export type StreamInput = {
    user: MessageV2.User
    sessionID: string
    model: Provider.Model
    agent: Agent.Info
    system: {
      env: string[]
      globalInstructions: string[]
      projectInstructions: string[]
    }
    abort: AbortSignal
    messages: ModelMessage[]
    sessionMessages?: MessageV2.WithParts[]
    /** Maps session message ID to its index in the messages array (before system blocks are prepended) */
    messageIdToIndex?: Map<string, number>
    /** The assistant message being generated (to assign promptIndex) */
    assistantMessage?: MessageV2.Assistant
    small?: boolean
    tools: Record<string, Tool>
    retries?: number
    /** One-shot probe: place an extra cache marker at this block index for testing */
    cacheProbeIndex?: number
    /** One-shot probe by message ID: resolved to block index using messageIdToIndex + system offset */
    cacheProbeMessageID?: string
  }

  export type StreamOutput = {
    stream: StreamTextResult<ToolSet, unknown>
    cacheMarkers: number[]
    systemBlockCount: number
  }

  export async function stream(input: StreamInput): Promise<StreamOutput> {
    const l = log
      .clone()
      .tag("providerID", input.model.providerID)
      .tag("modelID", input.model.id)
      .tag("sessionID", input.sessionID)
      .tag("small", (input.small ?? false).toString())
      .tag("agent", input.agent.name)
      .tag("mode", input.agent.mode)
    l.info("stream", {
      modelID: input.model.id,
      providerID: input.model.providerID,
    })
    const [language, cfg, provider, auth] = await Promise.all([
      Provider.getLanguage(input.model),
      Config.get(),
      Provider.getProvider(input.model.providerID),
      Auth.get(input.model.providerID),
    ])
    const isCodex = provider.id === "openai" && auth?.type === "oauth"

    // Two system blocks, both get 1h cache markers.
    //   [0] S1: provider prompt + global instructions
    //   [1] S2: environment + project instructions + user.system
    //
    // See selectCacheMarkers() in provider/transform.ts for marker strategy.
    const system: string[] = []

    // Any block ahead of S1 comes from a plugin through the
    // experimental.chat.system.transform hook, not from this file.
    const providerPrompt = input.agent.prompt
      ? input.agent.prompt
      : isCodex
        ? ""
        : SystemPrompt.provider(input.model).join("\n")
    const globalInstructions = input.system.globalInstructions.join("\n")
    const s1 = [providerPrompt, globalInstructions].filter(Boolean).join("\n")
    if (s1) system.push(s1)

    const envBlock = input.system.env.join("\n")
    const projectBlock = [...input.system.projectInstructions, ...(input.user.system ? [input.user.system] : [])]
      .filter(Boolean)
      .join("\n")
    const s2 = [envBlock, projectBlock].filter(Boolean).join("\n")
    if (s2) system.push(s2)

    const original = clone(system)
    await Plugin.trigger(
      "experimental.chat.system.transform",
      { sessionID: input.sessionID, model: input.model },
      { system },
    )
    if (system.length === 0) {
      system.push(...original)
    }

    // Assign prompt indices to session messages based on actual position in LLM prompt
    // The final prompt is: [system blocks] + [model messages]
    // messageIdToIndex maps session message ID -> index in model messages array
    if (input.sessionMessages && input.messageIdToIndex) {
      const offset = system.length
      for (const msg of input.sessionMessages) {
        const modelIndex = input.messageIdToIndex.get(msg.info.id)
        if (modelIndex !== undefined) {
          msg.info.promptIndex = offset + modelIndex
        }
      }
      // Persist indices for non-synthetic messages
      for (const msg of input.sessionMessages) {
        if (msg.info.synthetic) continue
        await Session.updateMessage(msg.info)
      }
      // Assign promptIndex to the assistant message being generated
      // It comes right after all the input messages
      if (input.assistantMessage) {
        input.assistantMessage.promptIndex = offset + input.messages.length
        await Session.updateMessage(input.assistantMessage)
      }
    }

    const variant =
      !input.small && input.model.variants && input.user.variant ? input.model.variants[input.user.variant] : {}
    const base = input.small
      ? ProviderTransform.smallOptions(input.model)
      : ProviderTransform.options({
          model: input.model,
          sessionID: input.sessionID,
          providerOptions: provider.options,
        })
    const options: Record<string, any> = pipe(
      base,
      mergeDeep(input.model.options),
      mergeDeep(input.agent.options),
      mergeDeep(variant),
    )
    if (isCodex) {
      options.instructions = SystemPrompt.instructions()
    }

    // For Claude models: temperature undefined when thinking enabled, 1 when disabled
    // "adaptive" variant uses adaptive thinking (injected via fetch wrapper), so treat it as thinking enabled.
    // We mark options._adaptiveThinking for normalizeMessages to preserve reasoning blocks.
    const isClaude = input.model.id.toLowerCase().includes("claude")
    const isAdaptiveThinking = input.user.variant === "adaptive"
    if (isAdaptiveThinking) options._adaptiveThinking = true
    const thinkingEnabled = Boolean(variant?.thinking || options?.thinking || isAdaptiveThinking)
    const temperature = (() => {
      if (!input.model.capabilities.temperature) return undefined
      if (input.agent.temperature !== undefined) return input.agent.temperature
      if (isClaude) return thinkingEnabled ? undefined : 1
      return ProviderTransform.temperature(input.model)
    })()

    const params = await Plugin.trigger(
      "chat.params",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        temperature,
        topP: input.agent.topP ?? ProviderTransform.topP(input.model),
        topK: ProviderTransform.topK(input.model),
        options,
      },
    )

    const { headers: pluginHeaders } = await Plugin.trigger(
      "chat.headers",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        headers: {},
      },
    )

    // Add beta headers for Anthropic models from config
    const headers: Record<string, string> = { ...pluginHeaders }
    if (input.model.providerID === "anthropic" && cfg.anthropic) {
      const modelConfig = cfg.anthropic.context?.[input.model.id]
      // Model-level beta overrides provider-level if set (even if empty array)
      const betaHeaders = modelConfig?.beta !== undefined ? modelConfig.beta : cfg.anthropic.beta
      if (betaHeaders && betaHeaders.length > 0) {
        const existing = headers["anthropic-beta"] || ""
        const betas = new Set(existing.split(",").filter(Boolean))
        for (const beta of betaHeaders) {
          betas.add(beta)
        }
        headers["anthropic-beta"] = [...betas].join(",")
      }
    }

    const maxOutputTokens =
      isCodex || provider.id.includes("github-copilot")
        ? undefined
        : ProviderTransform.maxOutputTokens(
            input.model.api.npm,
            params.options,
            input.model.limit.output,
            OUTPUT_TOKEN_MAX,
            input.model.id,
          )

    const tools = await resolveTools(input)

    const toolEntries = Object.entries(tools)
      .map(([id, tool]) => ({
        id,
        description: tool.description,
        schema: tool.inputSchema,
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
    const toolHashes = toolEntries.map((entry) => ({
      id: entry.id,
      hash: createHash("sha256")
        .update(JSON.stringify({ description: entry.description, schema: entry.schema }))
        .digest("hex"),
    }))
    const system0 = system[0] ?? ""
    const toolsHash = createHash("sha256").update(JSON.stringify(toolEntries)).digest("hex")
    const system0Hash = createHash("sha256").update(system0).digest("hex")
    const prefixHash = createHash("sha256")
      .update(JSON.stringify({ tools: toolEntries, system0 }))
      .digest("hex")
    l.info("CACHE_PREFIX_HASH_V1", {
      toolsHash,
      system0Hash,
      prefixHash,
      toolCount: toolEntries.length,
      system0Length: system0.length,
    })
    l.info("CACHE_TOOL_HASHES_V1", {
      toolCount: toolEntries.length,
      tools: toolHashes,
    })

    // LiteLLM and some Anthropic proxies require the tools parameter to be present
    // when message history contains tool calls, even if no tools are being used.
    // Add a dummy tool that is never called to satisfy this validation.
    // This is enabled for:
    // 1. Providers with "litellm" in their ID or API ID (auto-detected)
    // 2. Providers with explicit "litellmProxy: true" option (opt-in for custom gateways)
    const isLiteLLMProxy =
      provider.options?.["litellmProxy"] === true ||
      input.model.providerID.toLowerCase().includes("litellm") ||
      input.model.api.id.toLowerCase().includes("litellm")

    if (isLiteLLMProxy && Object.keys(tools).length === 0 && hasToolCalls(input.messages)) {
      tools["_noop"] = tool({
        description:
          "Placeholder for LiteLLM/Anthropic proxy compatibility - required when message history contains tool calls but no active tools are needed",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => ({ output: "", title: "", metadata: {} }),
      })
    }

    // Build the final messages array for the LLM
    const finalMessages: ModelMessage[] = [
      ...system.map(
        (x): ModelMessage => ({
          role: "system",
          content: x,
        }),
      ),
      ...input.messages,
    ]

    // Resolve message ID probe to block index (add system offset since idToIndex is conversation-only)
    let probeIndex = input.cacheProbeIndex
    if (probeIndex === undefined && input.cacheProbeMessageID && input.messageIdToIndex) {
      const convIndex = input.messageIdToIndex.get(input.cacheProbeMessageID)
      if (convIndex !== undefined) probeIndex = convIndex + system.length
    }

    // Calculate cache marker indices based on the final messages
    const cacheMarkers = ProviderTransform.cacheMarkerIndices(finalMessages, probeIndex)

    const stream = streamText({
      onError(error) {
        l.error("stream error", {
          error,
        })
      },
      async experimental_repairToolCall(failed) {
        const lower = failed.toolCall.toolName.toLowerCase()
        if (lower !== failed.toolCall.toolName && tools[lower]) {
          l.info("repairing tool call", {
            tool: failed.toolCall.toolName,
            repaired: lower,
          })
          return {
            ...failed.toolCall,
            toolName: lower,
          }
        }
        return {
          ...failed.toolCall,
          input: JSON.stringify({
            tool: failed.toolCall.toolName,
            error: failed.error.message,
          }),
          toolName: "invalid",
        }
      },
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      providerOptions: ProviderTransform.providerOptions(input.model, params.options),
      activeTools: Object.keys(tools).filter((x) => x !== "invalid"),
      tools,
      maxOutputTokens,
      abortSignal: input.abort,
      headers: {
        ...(input.model.providerID.startsWith("opencode")
          ? {
              "x-opencode-project": Instance.project.id,
              "x-opencode-session": input.sessionID,
              "x-opencode-request": input.user.id,
              "x-opencode-client": Flag.OPENCODE_CLIENT,
            }
          : input.model.providerID !== "anthropic"
            ? {
                "User-Agent": `opencode/${Installation.VERSION}`,
              }
            : undefined),
        ...input.model.headers,
        ...headers,
      },
      maxRetries: input.retries ?? 0,
      messages: finalMessages,
      model: wrapLanguageModel({
        model: language,
        middleware: [
          {
            async transformParams(args) {
              if (args.type === "stream") {
                // @ts-expect-error
                args.params.prompt = ProviderTransform.message(
                  args.params.prompt,
                  input.model,
                  options,
                  probeIndex,
                )
              }
              return args.params
            },
          },
        ],
      }),
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
          sessionId: input.sessionID,
        },
      },
    })

    return { stream, cacheMarkers, systemBlockCount: system.length }
  }

  async function resolveTools(input: Pick<StreamInput, "tools" | "user">) {
    // NOTE: We intentionally do NOT filter tools based on agent permissions here.
    // Tool schemas must remain stable across mode switches (plan <-> build) for
    // Anthropic prompt caching to work. Permissions are enforced at execution time
    // by tools that call PermissionNext.ask(); a denied tool that never asks is not
    // blocked here.
    for (const tool of Object.keys(input.tools)) {
      if (input.user.tools?.[tool] === false) {
        delete input.tools[tool]
      }
    }
    return input.tools
  }

  // Check if messages contain any tool-call content
  // Used to determine if a dummy tool should be added for LiteLLM proxy compatibility
  export function hasToolCalls(messages: ModelMessage[]): boolean {
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue
      for (const part of msg.content) {
        if (part.type === "tool-call" || part.type === "tool-result") return true
      }
    }
    return false
  }
}
