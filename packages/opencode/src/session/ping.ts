import { Log } from "@/util/log"
import { Session } from "."
import { MessageV2 } from "./message-v2"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { LLM } from "./llm"
import { SystemPrompt } from "./system"
import { InstructionPrompt } from "./instruction"
import { ProviderTransform } from "@/provider/transform"
import { Plugin } from "@/plugin"
import { clone } from "remeda"
import { SessionPrompt } from "./prompt"
import { computeStepCost } from "./processor"
import { Config } from "@/config/config"

export const CACHE_TTL = 5 * 60 * 1000
const DEFAULT_BEFORE_EXPIRY = 10

export async function beforeExpiry() {
  const cfg = await Config.get()
  const seconds = cfg.ping?.before_expiry ?? DEFAULT_BEFORE_EXPIRY
  return seconds * 1000
}

export namespace SessionPing {
  const log = Log.create({ service: "session.ping" })

  const active = new Map<string, { abort: AbortController; id: number }>()
  let loopId = 0

  export function start(sessionID: string) {
    if (active.has(sessionID)) return
    const abort = new AbortController()
    const id = ++loopId
    active.set(sessionID, { abort, id })
    run(sessionID, abort.signal, id)
  }

  export function stop(sessionID: string) {
    const entry = active.get(sessionID)
    if (!entry) return
    entry.abort.abort()
    active.delete(sessionID)
  }

  export async function probe(sessionID: string, cacheProbeMessageID: string) {
    stop(sessionID)
    const abort = new AbortController()
    await ping(sessionID, abort.signal, { cacheProbeMessageID })
    start(sessionID)
  }

  async function run(sessionID: string, signal: AbortSignal, id: number) {
    while (!signal.aborted) {
      try {
        const delay = await timeUntilPing(sessionID)
        if (delay === null) {
          log.info("cache expired, stopping ping loop", { sessionID })
          break
        }
        await sleep(delay, signal)
        if (signal.aborted) break
        await ping(sessionID, signal)
      } catch (e: any) {
        if (e.name === "AbortError") break
        log.error("ping loop error", { sessionID, error: e })
        continue
      }
    }
    // Only delete if we're still the active loop (not replaced by a newer one)
    const entry = active.get(sessionID)
    if (entry?.id === id) active.delete(sessionID)
  }

  async function timeUntilPing(sessionID: string) {
    const session = await Session.get(sessionID)
    const msgs = await Session.messages({ sessionID })
    const last = [...msgs].reverse().find((m) => m.info.role === "assistant")
    if (!last || last.info.role !== "assistant") return null
    const completed = last.info.time.completed
    if (!completed) return null
    const pingTime = session.ping?.time ?? 0
    const base = Math.max(completed, pingTime)
    const expiry = base + CACHE_TTL
    const now = Date.now()
    if (expiry <= now) return null
    const before = await beforeExpiry()
    const target = expiry - before
    const delay = target - now
    return Math.max(0, delay)
  }

  async function ping(sessionID: string, signal: AbortSignal, options?: { cacheProbeMessageID?: string }) {
    log.info("pinging", { sessionID, probe: options?.cacheProbeMessageID })

    const session = await Session.get(sessionID)
    const msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID))
    if (!msgs.length) return

    let lastUser: MessageV2.User | undefined
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].info.role === "user") {
        lastUser = msgs[i].info as MessageV2.User
        break
      }
    }
    if (!lastUser) return

    const model = await Provider.getModel(lastUser.model.providerID, lastUser.model.modelID)
    const agent = await Agent.get(lastUser.agent)
    const instructions = await InstructionPrompt.system()

    const sessionMessages = clone(msgs)
    await Plugin.trigger("experimental.chat.messages.transform", {}, { messages: sessionMessages })

    const variants = model.variants ?? ProviderTransform.variants(model)
    const variant = lastUser.variant ? variants[lastUser.variant] : undefined
    const stripReasoning =
      (model.api.npm === "@ai-sdk/anthropic" || model.api.npm === "@ai-sdk/google-vertex/anthropic") &&
      variant?.thinking?.type !== "enabled"

    const { messages: modelMessages, idToIndex } = MessageV2.toModelMessages(sessionMessages, model)
    const stripped = stripReasoning
      ? modelMessages.map((msg) => {
          if (msg.role !== "assistant" || !Array.isArray(msg.content)) return msg
          return {
            ...msg,
            content: msg.content.filter((part) => part.type !== "reasoning"),
          }
        })
      : modelMessages

    // Append ephemeral "." user message
    const allMessages = [
      ...stripped,
      { role: "user" as const, content: "." },
    ]

    const tools = await SessionPrompt.resolveTools({
      agent,
      session,
      model,
      tools: lastUser.tools,
      processor: undefined as any,
      bypassAgentCheck: false,
      messages: msgs,
    })

    await Session.update(sessionID, (draft) => {
      draft.ping = {
        count: draft.ping?.count ?? 0,
        time: draft.ping?.time ?? 0,
        pending: true,
      }
    })

    const { stream } = await LLM.stream({
      user: lastUser,
      agent,
      abort: signal,
      sessionID,
      system: {
        env: SystemPrompt.environment({ created: session.time.created, branch: session.branch }),
        globalInstructions: instructions.global,
        projectInstructions: instructions.project,
      },
      messages: allMessages,
      sessionMessages,
      messageIdToIndex: idToIndex,
      tools,
      model,
      cacheProbeMessageID: options?.cacheProbeMessageID,
    })

    // Consume stream until finish-step to get usage metadata, then stop
    for await (const value of stream.fullStream) {
      if (signal.aborted) break
      if (value.type === "finish-step") {
        const usage = Session.getUsage({
          model,
          usage: value.usage,
          metadata: value.providerMetadata,
        })
        const weightedInput = usage.tokens.cache.read * 0.1 + usage.tokens.cache.write * 1.25
        const weightedOutput = usage.tokens.output + usage.tokens.reasoning
        const stepCost = computeStepCost(model.providerID, model.id, usage.tokens)
        await Session.update(sessionID, (draft) => {
          draft.tokens.input = usage.tokens.input
          draft.tokens.cacheRead = usage.tokens.cache.read
          draft.tokens.cacheWrite = usage.tokens.cache.write
          draft.tokens.output = usage.tokens.output
          draft.tokens.reasoning = usage.tokens.reasoning
          draft.total.input += weightedInput
          draft.total.output += weightedOutput
          draft.cost += stepCost
          draft.ping = {
            count: (draft.ping?.count ?? 0) + 1,
            time: Date.now(),
          }
        })
        log.info("ping complete", {
          sessionID,
          count: (session.ping?.count ?? 0) + 1,
          cacheRead: usage.tokens.cache.read,
          cost: stepCost,
        })
        break
      }
    }
  }

  function sleep(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"))
      const timer = setTimeout(resolve, ms)
      signal.addEventListener("abort", () => {
        clearTimeout(timer)
        reject(new DOMException("Aborted", "AbortError"))
      }, { once: true })
    })
  }
}
