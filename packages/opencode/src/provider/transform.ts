import type { APICallError, ModelMessage } from "ai"
import { mergeDeep, unique } from "remeda"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { createHash } from "crypto"
import { Log } from "@/util/log"
import type { JSONSchema } from "zod/v4/core"
import type { Provider } from "./provider"
import type { ModelsDev } from "./models"
import { iife } from "@/util/iife"

type Modality = NonNullable<ModelsDev.Model["modalities"]>["input"][number]

function mimeToModality(mime: string): Modality | undefined {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
  return undefined
}

export namespace ProviderTransform {
  const log = Log.create({ service: "provider.transform" })
  // Maps npm package to the key the AI SDK expects for providerOptions
  function sdkKey(npm: string): string | undefined {
    switch (npm) {
      case "@ai-sdk/github-copilot":
        return "copilot"
      case "@ai-sdk/openai":
      case "@ai-sdk/azure":
        return "openai"
      case "@ai-sdk/amazon-bedrock":
        return "bedrock"
      case "@ai-sdk/anthropic":
      case "@ai-sdk/google-vertex/anthropic":
        return "anthropic"
      case "@ai-sdk/google-vertex":
      case "@ai-sdk/google":
        return "google"
      case "@ai-sdk/gateway":
        return "gateway"
      case "@openrouter/ai-sdk-provider":
        return "openrouter"
    }
    return undefined
  }

  function normalizeMessages(
    msgs: ModelMessage[],
    model: Provider.Model,
    options: Record<string, unknown>,
  ): ModelMessage[] {
    // Anthropic rejects messages with empty content - filter out empty string messages
    // and remove empty text/reasoning parts from array content
    if (model.api.npm === "@ai-sdk/anthropic" || model.api.npm === "@ai-sdk/google-vertex/anthropic") {
      // Strip trailing reasoning from the last assistant message so Anthropic
      // doesn't try to continue from a thinking block.  Done here (at send time)
      // rather than in toModelMessages so stored messages stay immutable.
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]
        if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue
        const parts = msg.content as Array<{ type: string }>
        let idx = parts.length - 1
        while (idx >= 0 && parts[idx]?.type === "reasoning") idx--
        if (idx < parts.length - 1) msg.content = parts.slice(0, idx + 1) as typeof msg.content
        if (!(msg.content as Array<{ type: string }>).some((p) => p.type !== "step-start"))
          msg.content = [{ type: "text", text: "[No message content]" }] as typeof msg.content
        break
      }
      msgs = msgs
        .map((msg) => {
          if (typeof msg.content === "string") {
            if (msg.content === "") return undefined
            return msg
          }
          if (!Array.isArray(msg.content)) return msg
          const filtered = msg.content.filter((part) => {
            if (part.type === "text" || part.type === "reasoning") {
              return part.text !== ""
            }
            return true
          })
          if (filtered.length === 0) return undefined
          return { ...msg, content: filtered }
        })
        .filter((msg): msg is ModelMessage => msg !== undefined && msg.content !== "")
    }

    if (model.api.id.includes("claude")) {
      return msgs.map((msg) => {
        if ((msg.role === "assistant" || msg.role === "tool") && Array.isArray(msg.content)) {
          msg.content = msg.content.map((part) => {
            if ((part.type === "tool-call" || part.type === "tool-result") && "toolCallId" in part) {
              return {
                ...part,
                toolCallId: part.toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_"),
              }
            }
            return part
          })
        }
        return msg
      })
    }
    if (
      model.providerID === "mistral" ||
      model.api.id.toLowerCase().includes("mistral") ||
      model.api.id.toLocaleLowerCase().includes("devstral")
    ) {
      const result: ModelMessage[] = []
      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i]
        const nextMsg = msgs[i + 1]

        if ((msg.role === "assistant" || msg.role === "tool") && Array.isArray(msg.content)) {
          msg.content = msg.content.map((part) => {
            if ((part.type === "tool-call" || part.type === "tool-result") && "toolCallId" in part) {
              // Mistral requires alphanumeric tool call IDs with exactly 9 characters
              const normalizedId = part.toolCallId
                .replace(/[^a-zA-Z0-9]/g, "") // Remove non-alphanumeric characters
                .substring(0, 9) // Take first 9 characters
                .padEnd(9, "0") // Pad with zeros if less than 9 characters

              return {
                ...part,
                toolCallId: normalizedId,
              }
            }
            return part
          })
        }

        result.push(msg)

        // Fix message sequence: tool messages cannot be followed by user messages
        if (msg.role === "tool" && nextMsg?.role === "user") {
          result.push({
            role: "assistant",
            content: [
              {
                type: "text",
                text: "Done.",
              },
            ],
          })
        }
      }
      return result
    }

    if (typeof model.capabilities.interleaved === "object" && model.capabilities.interleaved.field) {
      const field = model.capabilities.interleaved.field
      return msgs.map((msg) => {
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          const reasoningParts = msg.content.filter((part: any) => part.type === "reasoning")
          const reasoningText = reasoningParts.map((part: any) => part.text).join("")

          // Filter out reasoning parts from content
          const filteredContent = msg.content.filter((part: any) => part.type !== "reasoning")

          // Include reasoning_content | reasoning_details directly on the message for all assistant messages
          if (reasoningText) {
            return {
              ...msg,
              content: filteredContent,
              providerOptions: {
                ...msg.providerOptions,
                openaiCompatible: {
                  ...(msg.providerOptions as any)?.openaiCompatible,
                  [field]: reasoningText,
                },
              },
            }
          }

          return {
            ...msg,
            content: filteredContent,
          }
        }

        return msg
      })
    }

    return msgs
  }

  /**
   * Select which messages should have cache markers.
   *
   * System block layout (built in llm.ts, after plugin transforms):
   *   [0] S0: any block a plugin prepends (experimental.chat.system.transform)
   *   [1] S1: provider prompt + global instructions (cross-repo stable)
   *   [2] S2: environment + project instructions (per-session)
   *
   * Strategy (up to 4 markers, all with 1h TTL for system):
   * - Last 2 system blocks get markers (S0 is within lookback of S1's marker)
   * - Last user-typed prompt: stable checkpoint for the current turn
   * - Last message (N): moves with each API call for incremental caching
   */
  function selectCacheMarkers(
    msgs: ModelMessage[],
    probeIndex?: number,
  ): { messages: ModelMessage[]; indices: number[] } {
    const systemMsgs = msgs.filter((msg) => msg.role === "system")
    const conversationMsgs = msgs.filter((msg) => msg.role !== "system")

    const markers: ModelMessage[] = []
    const indices: number[] = []

    // Only mark the last 2 system blocks (up to 4 markers total).
    // Earlier system blocks are within the 20-block lookback window
    // of subsequent markers and get cached for free.
    const systemToMark = systemMsgs.slice(-2)
    for (const msg of systemToMark) {
      markers.push(msg)
      indices.push(msgs.indexOf(msg))
    }

    const lastUserPrompt = conversationMsgs.findLast((msg) => msg.role === "user" && !isMetaMessage(msg))
    if (lastUserPrompt) {
      markers.push(lastUserPrompt)
      indices.push(msgs.indexOf(lastUserPrompt))
    }

    if (probeIndex !== undefined && probeIndex >= 0 && probeIndex < msgs.length) {
      const probeMsg = msgs[probeIndex]
      if (probeMsg && probeMsg !== lastUserPrompt && probeMsg.role !== "system") {
        log.info("cache probe marker", { probeIndex })
        markers.push(probeMsg)
        indices.push(probeIndex)
      }
    } else {
      const lastMessage = msgs[msgs.length - 1]
      if (lastMessage && lastMessage !== lastUserPrompt && lastMessage.role !== "system") {
        markers.push(lastMessage)
        indices.push(msgs.length - 1)
      } else {
        const lastAssistant = conversationMsgs.findLast((msg) => msg.role === "assistant")
        if (lastAssistant && lastAssistant !== lastUserPrompt) {
          markers.push(lastAssistant)
          indices.push(msgs.indexOf(lastAssistant))
        }
      }
    }

    return { messages: markers, indices }
  }

  function applyCaching(msgs: ModelMessage[], providerID: string, probeIndex?: number): ModelMessage[] {
    const { messages: markerMsgs, indices } = selectCacheMarkers(msgs, probeIndex)

    log.info("cache markers", {
      providerID,
      indices,
      system: markerMsgs
        .filter((msg) => msg.role === "system")
        .map((msg, i) => {
          const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? [])
          return {
            index: i,
            hash: createHash("sha256").update(text).digest("hex"),
            length: text.length,
          }
        }),
    })

    const providerOptions = {
      anthropic: {
        cacheControl: { type: "ephemeral" },
      },
      openrouter: {
        cacheControl: { type: "ephemeral" },
      },
      bedrock: {
        cachePoint: { type: "default" },
      },
      openaiCompatible: {
        cache_control: { type: "ephemeral" },
      },
      copilot: {
        copilot_cache_control: { type: "ephemeral" },
      },
    }
    const systemProviderOptions = {
      anthropic: {
        cacheControl: { type: "ephemeral", ttl: "1h" },
      },
      openrouter: {
        cacheControl: { type: "ephemeral" },
      },
      bedrock: {
        cachePoint: { type: "ephemeral" },
      },
      openaiCompatible: {
        cache_control: { type: "ephemeral" },
      },
    }

    for (const msg of unique(markerMsgs)) {
      const isSystem = msg.role === "system"
      const options = isSystem ? systemProviderOptions : providerOptions
      const useMessageLevelOptions = providerID === "anthropic" || providerID.includes("bedrock")
      const shouldUseContentOptions = !useMessageLevelOptions && Array.isArray(msg.content) && msg.content.length > 0

      if (shouldUseContentOptions) {
        const lastContent = msg.content[msg.content.length - 1]
        if (lastContent && typeof lastContent === "object") {
          lastContent.providerOptions = mergeDeep(lastContent.providerOptions ?? {}, options)
          continue
        }
      }

      msg.providerOptions = mergeDeep(msg.providerOptions ?? {}, options)
    }

    return msgs
  }

  /**
   * Calculate the indices of cache marker positions in the message array.
   *
   * Anthropic caches the prefix up to and including each marker. On subsequent calls,
   * the system checks backwards from each marker (up to 20 blocks) to find cache hits.
   *
   * A block at index N can get a cache hit if:
   *   markers.some(marker => N >= marker - 19 && N <= marker)
   *
   * For example, if markers are at [0, 1, 150, 180] (system, system, user prompt, N):
   *   - Blocks 0-1 are within lookback of markers 0, 1 (system cache)
   *   - Blocks 131-150 are within lookback of marker 150 (user prompt checkpoint)
   *   - Blocks 161-180 are within lookback of marker 180 (N - current position)
   *   - The user prompt marker at 150 stays fixed during a turn, while N moves
   *     with each API call, enabling incremental caching throughout long tool chains
   */
  export function cacheMarkerIndices(msgs: ModelMessage[], probeIndex?: number): number[] {
    return selectCacheMarkers(msgs, probeIndex).indices
  }

  function isMetaMessage(msg: ModelMessage) {
    if (msg.role !== "user") return false
    if (typeof msg.content === "string") return isSyntheticContent(msg.content)
    if (!Array.isArray(msg.content)) return false
    if (msg.content.length !== 1) return false
    const part = msg.content[0]
    if (!part || typeof part !== "object" || part.type !== "text") return false
    return isSyntheticContent(part.text)
  }

  function isSyntheticContent(text: string) {
    const trimmed = text.trim()
    if (trimmed.startsWith("<system-reminder>") && trimmed.endsWith("</system-reminder>")) return true
    return false
  }

  function unsupportedParts(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
    return msgs.map((msg) => {
      if (msg.role !== "user" || !Array.isArray(msg.content)) return msg

      const filtered = msg.content.map((part) => {
        if (part.type !== "file" && part.type !== "image") return part

        // Check for empty base64 image data
        if (part.type === "image") {
          const imageStr = part.image.toString()
          if (imageStr.startsWith("data:")) {
            const match = imageStr.match(/^data:([^;]+);base64,(.*)$/)
            if (match && (!match[2] || match[2].length === 0)) {
              return {
                type: "text" as const,
                text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
              }
            }
          }
        }

        const mime = part.type === "image" ? part.image.toString().split(";")[0].replace("data:", "") : part.mediaType
        const filename = part.type === "file" ? part.filename : undefined
        const modality = mimeToModality(mime)
        if (!modality) return part
        if (model.capabilities.input[modality]) return part

        const name = filename ? `"${filename}"` : modality
        return {
          type: "text" as const,
          text: `ERROR: Cannot read ${name} (this model does not support ${modality} input). Inform the user.`,
        }
      })

      return { ...msg, content: filtered }
    })
  }

  export function message(
    msgs: ModelMessage[],
    model: Provider.Model,
    options: Record<string, unknown>,
    probeIndex?: number,
  ) {
    msgs = unsupportedParts(msgs, model)
    msgs = normalizeMessages(msgs, model, options)
    if (
      model.providerID === "anthropic" ||
      model.api.id.includes("anthropic") ||
      model.api.id.includes("claude") ||
      model.id.includes("anthropic") ||
      model.id.includes("claude") ||
      model.api.npm === "@ai-sdk/anthropic"
    ) {
      msgs = applyCaching(msgs, model.providerID, probeIndex)
    }

    // Remap providerOptions keys from stored providerID to expected SDK key
    const key = sdkKey(model.api.npm)
    if (key && key !== model.providerID && model.api.npm !== "@ai-sdk/azure") {
      const remap = (opts: Record<string, any> | undefined) => {
        if (!opts) return opts
        if (!(model.providerID in opts)) return opts
        const result = { ...opts }
        result[key] = result[model.providerID]
        delete result[model.providerID]
        return result
      }

      msgs = msgs.map((msg) => {
        if (!Array.isArray(msg.content)) return { ...msg, providerOptions: remap(msg.providerOptions) }
        return {
          ...msg,
          providerOptions: remap(msg.providerOptions),
          content: msg.content.map((part) => ({ ...part, providerOptions: remap(part.providerOptions) })),
        } as typeof msg
      })
    }

    return msgs
  }

  export function temperature(model: Provider.Model) {
    const id = model.id.toLowerCase()
    if (id.includes("qwen")) return 0.55
    // Claude temperature is handled in llm.ts based on thinking state
    if (id.includes("gemini")) return 1.0
    if (id.includes("glm-4.6")) return 1.0
    if (id.includes("glm-4.7")) return 1.0
    if (id.includes("minimax-m2")) return 1.0
    if (id.includes("kimi-k2")) {
      // kimi-k2-thinking & kimi-k2.5 && kimi-k2p5
      if (id.includes("thinking") || id.includes("k2.") || id.includes("k2p")) {
        return 1.0
      }
      return 0.6
    }
    return undefined
  }

  export function topP(model: Provider.Model) {
    const id = model.id.toLowerCase()
    if (id.includes("qwen")) return 1
    if (id.includes("minimax-m2") || id.includes("kimi-k2.5") || id.includes("kimi-k2p5") || id.includes("gemini")) {
      return 0.95
    }
    return undefined
  }

  export function topK(model: Provider.Model) {
    const id = model.id.toLowerCase()
    if (id.includes("minimax-m2")) {
      if (id.includes("m2.1")) return 40
      return 20
    }
    if (id.includes("gemini")) return 64
    return undefined
  }

  const WIDELY_SUPPORTED_EFFORTS = ["low", "medium", "high"]
  const OPENAI_EFFORTS = ["none", "minimal", ...WIDELY_SUPPORTED_EFFORTS, "xhigh"]

  export function variants(model: Provider.Model): Record<string, Record<string, any>> {
    if (!model.capabilities.reasoning) return {}

    const id = model.id.toLowerCase()
    if (
      id.includes("deepseek") ||
      id.includes("minimax") ||
      id.includes("glm") ||
      id.includes("mistral") ||
      id.includes("kimi") ||
      // TODO: Remove this after models.dev data is fixed to use "kimi-k2.5" instead of "k2p5"
      id.includes("k2p5")
    )
      return {}

    // see: https://docs.x.ai/docs/guides/reasoning#control-how-hard-the-model-thinks
    if (id.includes("grok") && id.includes("grok-3-mini")) {
      if (model.api.npm === "@openrouter/ai-sdk-provider") {
        return {
          low: { reasoning: { effort: "low" } },
          high: { reasoning: { effort: "high" } },
        }
      }
      return {
        low: { reasoningEffort: "low" },
        high: { reasoningEffort: "high" },
      }
    }
    if (id.includes("grok")) return {}

    switch (model.api.npm) {
      case "@openrouter/ai-sdk-provider":
        if (!model.id.includes("gpt") && !model.id.includes("gemini-3")) return {}
        return Object.fromEntries(OPENAI_EFFORTS.map((effort) => [effort, { reasoning: { effort } }]))

      // TODO: YOU CANNOT SET max_tokens if this is set!!!
      case "@ai-sdk/gateway":
        return Object.fromEntries(OPENAI_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))

      case "@ai-sdk/github-copilot":
        if (model.id.includes("gemini")) {
          // currently github copilot only returns thinking
          return {}
        }
        if (model.id.includes("claude")) {
          return {
            thinking: { thinking_budget: 4000 },
          }
        }
        const copilotEfforts = iife(() => {
          if (id.includes("5.1-codex-max") || id.includes("5.2")) return [...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
          return WIDELY_SUPPORTED_EFFORTS
        })
        return Object.fromEntries(
          copilotEfforts.map((effort) => [
            effort,
            {
              reasoningEffort: effort,
              reasoningSummary: "auto",
              include: ["reasoning.encrypted_content"],
            },
          ]),
        )

      case "@ai-sdk/cerebras":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/cerebras
      case "@ai-sdk/togetherai":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/togetherai
      case "@ai-sdk/xai":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/xai
      case "@ai-sdk/deepinfra":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/deepinfra
      case "@ai-sdk/openai-compatible":
        return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))

      case "@ai-sdk/azure":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/azure
        if (id === "o1-mini") return {}
        const azureEfforts = ["low", "medium", "high"]
        if (id.includes("gpt-5-") || id === "gpt-5") {
          azureEfforts.unshift("minimal")
        }
        return Object.fromEntries(
          azureEfforts.map((effort) => [
            effort,
            {
              reasoningEffort: effort,
              reasoningSummary: "auto",
              include: ["reasoning.encrypted_content"],
            },
          ]),
        )
      case "@ai-sdk/openai":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/openai
        if (id === "gpt-5-pro") return {}
        const openaiEfforts = iife(() => {
          if (id.includes("codex")) {
            if (id.includes("5.2")) return [...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
            return WIDELY_SUPPORTED_EFFORTS
          }
          const arr = [...WIDELY_SUPPORTED_EFFORTS]
          if (id.includes("gpt-5-") || id === "gpt-5") {
            arr.unshift("minimal")
          }
          if (model.release_date >= "2025-11-13") {
            arr.unshift("none")
          }
          if (model.release_date >= "2025-12-04") {
            arr.push("xhigh")
          }
          return arr
        })
        return Object.fromEntries(
          openaiEfforts.map((effort) => [
            effort,
            {
              reasoningEffort: effort,
              reasoningSummary: "auto",
              include: ["reasoning.encrypted_content"],
            },
          ]),
        )

      case "@ai-sdk/anthropic":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/anthropic
      case "@ai-sdk/google-vertex/anthropic":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-vertex#anthropic-provider
        return {
          // Adaptive thinking: model decides thinking budget dynamically.
          // Requires adaptive-thinking-2026-01-28 beta header.
          // The SDK doesn't support type:"adaptive" natively and rejects it in validation,
          // so we only pass effort here. The fetch wrapper in provider.ts injects
          // thinking:{type:"adaptive"} into the request body when the adaptive-thinking
          // beta header is present.
          adaptive: {
            effort: "high",
          },
          high: {
            thinking: {
              type: "enabled",
              budgetTokens: Math.min(16_000, Math.floor(model.limit.output / 2 - 1)),
            },
          },
          max: {
            thinking: {
              type: "enabled",
              budgetTokens: Math.min(31_999, model.limit.output - 1),
            },
          },
        }

      case "@ai-sdk/amazon-bedrock":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/amazon-bedrock
        // For Anthropic models on Bedrock, use reasoningConfig with budgetTokens
        if (model.api.id.includes("anthropic")) {
          return {
            high: {
              reasoningConfig: {
                type: "enabled",
                budgetTokens: 16000,
              },
            },
            max: {
              reasoningConfig: {
                type: "enabled",
                budgetTokens: 31999,
              },
            },
          }
        }

        // For Amazon Nova models, use reasoningConfig with maxReasoningEffort
        return Object.fromEntries(
          WIDELY_SUPPORTED_EFFORTS.map((effort) => [
            effort,
            {
              reasoningConfig: {
                type: "enabled",
                maxReasoningEffort: effort,
              },
            },
          ]),
        )

      case "@ai-sdk/google-vertex":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-vertex
      case "@ai-sdk/google":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai
        if (id.includes("2.5")) {
          return {
            high: {
              thinkingConfig: {
                includeThoughts: true,
                thinkingBudget: 16000,
              },
            },
            max: {
              thinkingConfig: {
                includeThoughts: true,
                thinkingBudget: 24576,
              },
            },
          }
        }
        return Object.fromEntries(
          ["low", "high"].map((effort) => [
            effort,
            {
              includeThoughts: true,
              thinkingLevel: effort,
            },
          ]),
        )

      case "@ai-sdk/mistral":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/mistral
        return {}

      case "@ai-sdk/cohere":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/cohere
        return {}

      case "@ai-sdk/groq":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/groq
        const groqEffort = ["none", ...WIDELY_SUPPORTED_EFFORTS]
        return Object.fromEntries(
          groqEffort.map((effort) => [
            effort,
            {
              includeThoughts: true,
              thinkingLevel: effort,
            },
          ]),
        )

      case "@ai-sdk/perplexity":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/perplexity
        return {}

      case "@mymediset/sap-ai-provider":
      case "@jerome-benoit/sap-ai-provider-v2":
        if (model.api.id.includes("anthropic")) {
          return {
            high: {
              thinking: {
                type: "enabled",
                budgetTokens: 16000,
              },
            },
            max: {
              thinking: {
                type: "enabled",
                budgetTokens: 31999,
              },
            },
          }
        }
        return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))
    }
    return {}
  }

  export function options(input: {
    model: Provider.Model
    sessionID: string
    providerOptions?: Record<string, any>
  }): Record<string, any> {
    const result: Record<string, any> = {}

    // openai and providers using openai package should set store to false by default.
    if (
      input.model.providerID === "openai" ||
      input.model.api.npm === "@ai-sdk/openai" ||
      input.model.api.npm === "@ai-sdk/github-copilot"
    ) {
      result["store"] = false
    }

    if (input.model.api.npm === "@openrouter/ai-sdk-provider") {
      result["usage"] = {
        include: true,
      }
      if (input.model.api.id.includes("gemini-3")) {
        result["reasoning"] = { effort: "high" }
      }
    }

    if (
      input.model.providerID === "baseten" ||
      (input.model.providerID === "opencode" && ["kimi-k2-thinking", "glm-4.6"].includes(input.model.api.id))
    ) {
      result["chat_template_args"] = { enable_thinking: true }
    }

    if (["zai", "zhipuai"].includes(input.model.providerID) && input.model.api.npm === "@ai-sdk/openai-compatible") {
      result["thinking"] = {
        type: "enabled",
        clear_thinking: false,
      }
    }

    if (input.model.providerID === "openai" || input.providerOptions?.setCacheKey) {
      result["promptCacheKey"] = input.sessionID
    }

    if (input.model.api.npm === "@ai-sdk/google" || input.model.api.npm === "@ai-sdk/google-vertex") {
      result["thinkingConfig"] = {
        includeThoughts: true,
      }
      if (input.model.api.id.includes("gemini-3")) {
        result["thinkingConfig"]["thinkingLevel"] = "high"
      }
    }

    if (input.model.api.id.includes("gpt-5") && !input.model.api.id.includes("gpt-5-chat")) {
      if (!input.model.api.id.includes("gpt-5-pro")) {
        result["reasoningEffort"] = "medium"
      }

      // Only set textVerbosity for non-chat gpt-5.x models
      // Chat models (e.g. gpt-5.2-chat-latest) only support "medium" verbosity
      if (
        input.model.api.id.includes("gpt-5.") &&
        !input.model.api.id.includes("codex") &&
        !input.model.api.id.includes("-chat") &&
        input.model.providerID !== "azure"
      ) {
        result["textVerbosity"] = "low"
      }

      if (input.model.providerID.startsWith("opencode")) {
        result["promptCacheKey"] = input.sessionID
        result["include"] = ["reasoning.encrypted_content"]
        result["reasoningSummary"] = "auto"
      }
    }

    if (input.model.providerID === "venice") {
      result["promptCacheKey"] = input.sessionID
    }

    return result
  }

  export function smallOptions(model: Provider.Model) {
    if (
      model.providerID === "openai" ||
      model.api.npm === "@ai-sdk/openai" ||
      model.api.npm === "@ai-sdk/github-copilot"
    ) {
      if (model.api.id.includes("gpt-5")) {
        if (model.api.id.includes("5.")) {
          return { store: false, reasoningEffort: "low" }
        }
        return { store: false, reasoningEffort: "minimal" }
      }
      return { store: false }
    }
    if (model.providerID === "google") {
      // gemini-3 uses thinkingLevel, gemini-2.5 uses thinkingBudget
      if (model.api.id.includes("gemini-3")) {
        return { thinkingConfig: { thinkingLevel: "minimal" } }
      }
      return { thinkingConfig: { thinkingBudget: 0 } }
    }
    if (model.providerID === "openrouter") {
      if (model.api.id.includes("google")) {
        return { reasoning: { enabled: false } }
      }
      return { reasoningEffort: "minimal" }
    }
    return {}
  }

  export function providerOptions(model: Provider.Model, options: { [x: string]: any }) {
    const key = sdkKey(model.api.npm) ?? model.providerID
    return { [key]: options }
  }

  export function anthropicMaxTokens(modelId: string): number {
    const id = modelId.toLowerCase()
    if (id.includes("3-5")) return 8192
    if (id.includes("claude-3-opus")) return 4096
    if (id.includes("claude-3-sonnet")) return 8192
    if (id.includes("claude-3-haiku")) return 4096
    if (id.includes("opus-4-5")) return 64000
    if (id.includes("opus-4")) return 32000
    if (id.includes("sonnet-4") || id.includes("haiku-4")) return 64000
    return 32000
  }

  export function maxOutputTokens(
    npm: string,
    options: Record<string, any>,
    modelLimit: number,
    globalLimit: number,
    modelId?: string,
  ): number {
    const modelCap = modelLimit || globalLimit

    if (npm === "@ai-sdk/anthropic" || npm === "@ai-sdk/google-vertex/anthropic") {
      const anthropicDefault = modelId ? anthropicMaxTokens(modelId) : globalLimit
      const standardLimit = Math.min(modelCap, anthropicDefault)

      const thinking = options?.["thinking"]
      const budgetTokens = typeof thinking?.["budgetTokens"] === "number" ? thinking["budgetTokens"] : 0
      const enabled = thinking?.["type"] === "enabled"
      if (enabled && budgetTokens > 0) {
        // Return text tokens so that text + thinking <= model cap, preferring model-specific limit when possible.
        if (budgetTokens + standardLimit <= modelCap) {
          return standardLimit
        }
        return modelCap - budgetTokens
      }
      return standardLimit
    }

    return Math.min(modelCap, globalLimit)
  }

  export function schema(model: Provider.Model, schema: JSONSchema.BaseSchema | JSONSchema7): JSONSchema7 {
    /*
    if (["openai", "azure"].includes(providerID)) {
      if (schema.type === "object" && schema.properties) {
        for (const [key, value] of Object.entries(schema.properties)) {
          if (schema.required?.includes(key)) continue
          schema.properties[key] = {
            anyOf: [
              value as JSONSchema.JSONSchema,
              {
                type: "null",
              },
            ],
          }
        }
      }
    }
    */

    // Convert integer enums to string enums for Google/Gemini
    if (model.providerID === "google" || model.api.id.includes("gemini")) {
      const sanitizeGemini = (obj: any): any => {
        if (obj === null || typeof obj !== "object") {
          return obj
        }

        if (Array.isArray(obj)) {
          return obj.map(sanitizeGemini)
        }

        const result: any = {}
        for (const [key, value] of Object.entries(obj)) {
          if (key === "enum" && Array.isArray(value)) {
            // Convert all enum values to strings
            result[key] = value.map((v) => String(v))
            // If we have integer type with enum, change type to string
            if (result.type === "integer" || result.type === "number") {
              result.type = "string"
            }
          } else if (typeof value === "object" && value !== null) {
            result[key] = sanitizeGemini(value)
          } else {
            result[key] = value
          }
        }

        // Filter required array to only include fields that exist in properties
        if (result.type === "object" && result.properties && Array.isArray(result.required)) {
          result.required = result.required.filter((field: any) => field in result.properties)
        }

        if (result.type === "array") {
          if (result.items == null) {
            result.items = {}
          }
          // Ensure items has at least a type if it's an empty object
          // This handles nested arrays like { type: "array", items: { type: "array", items: {} } }
          if (typeof result.items === "object" && !Array.isArray(result.items) && !result.items.type) {
            result.items.type = "string"
          }
        }

        // Remove properties/required from non-object types (Gemini rejects these)
        if (result.type && result.type !== "object") {
          delete result.properties
          delete result.required
        }

        return result
      }

      schema = sanitizeGemini(schema)
    }

    return schema as JSONSchema7
  }

  export function error(providerID: string, error: APICallError) {
    let message = error.message
    if (providerID.includes("github-copilot") && error.statusCode === 403) {
      return "Please reauthenticate with the copilot provider to ensure your credentials work properly with Faber."
    }
    if (providerID.includes("github-copilot") && message.includes("The requested model is not supported")) {
      return (
        message +
        "\n\nMake sure the model is enabled in your copilot settings: https://github.com/settings/copilot/features"
      )
    }

    return message
  }
}
