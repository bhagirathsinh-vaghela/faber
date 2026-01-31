import os from "os"
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
  extractReasoningMiddleware,
  tool,
  jsonSchema,
} from "ai"
import { createHash } from "crypto"
import { clone, mergeDeep, pipe } from "remeda"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
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
    small?: boolean
    tools: Record<string, Tool>
    retries?: number
  }

  export type StreamOutput = StreamTextResult<ToolSet, unknown>

  export async function stream(input: StreamInput) {
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

    // Build system as separate blocks for cache optimization
    // Block 1: Provider prompt (marker target - cross-machine cache)
    // Block 2: Global instructions (marker target - cross-repo cache)
    // Block 3: Environment (repo/session specific)
    // Block 4: Project instructions + user.system
    const system: string[] = []

    // Block 1: Provider/agent prompt
    const providerPrompt = input.agent.prompt
      ? input.agent.prompt
      : isCodex
        ? ""
        : SystemPrompt.provider(input.model).join("\n")
    if (providerPrompt) system.push(providerPrompt)

    // Block 2: Global instructions (cross-repo stable)
    const globalInstructions = input.system.globalInstructions.join("\n")
    if (globalInstructions) system.push(globalInstructions)

    // Block 3: Environment (repo/session specific)
    const envBlock = input.system.env.join("\n")
    if (envBlock) system.push(envBlock)

    // Block 4: Project instructions + user.system
    const projectBlock = [...input.system.projectInstructions, ...(input.user.system ? [input.user.system] : [])]
      .filter(Boolean)
      .join("\n")
    if (projectBlock) system.push(projectBlock)

    const original = clone(system)
    await Plugin.trigger(
      "experimental.chat.system.transform",
      { sessionID: input.sessionID, model: input.model },
      { system },
    )
    if (system.length === 0) {
      system.push(...original)
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
        temperature: input.model.capabilities.temperature
          ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
          : undefined,
        topP: input.agent.topP ?? ProviderTransform.topP(input.model),
        topK: ProviderTransform.topK(input.model),
        options,
      },
    )

    const { headers } = await Plugin.trigger(
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

    const maxOutputTokens = isCodex ? undefined : undefined
    log.info("max_output_tokens", {
      tokens: ProviderTransform.maxOutputTokens(
        input.model.api.npm,
        params.options,
        input.model.limit.output,
        OUTPUT_TOKEN_MAX,
      ),
      modelOptions: params.options,
      outputLimit: input.model.limit.output,
    })
    // tokens = 32000
    // outputLimit = 64000
    // modelOptions={"reasoningEffort":"minimal"}

    const tools = await resolveTools(input)

    if (Installation.isLocal()) {
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
    }

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

    return streamText({
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
      messages: [
        ...(isCodex
          ? [
              {
                role: "user",
                content: system.join("\n\n"),
              } as ModelMessage,
            ]
          : system.map(
              (x): ModelMessage => ({
                role: "system",
                content: x,
              }),
            )),
        ...input.messages,
      ],
      model: wrapLanguageModel({
        model: language,
        middleware: [
          {
            async transformParams(args) {
              if (args.type === "stream") {
                // @ts-expect-error
                args.params.prompt = ProviderTransform.message(args.params.prompt, input.model, options)
              }
              return args.params
            },
          },
          extractReasoningMiddleware({ tagName: "think", startWithReasoning: false }),
        ],
      }),
      experimental_telemetry: { isEnabled: cfg.experimental?.openTelemetry },
    })
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
