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
// How long the daemon sleeps between re-checks while it has nothing to ping
// (cache expired, no anchor yet, or session state transiently unreadable).
// Coarse on purpose: when a window IS live the loop sleeps the exact time to
// the ping instead, so this never affects ping timing.
const IDLE_TICK = 10 * 1000

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

  // The daemon stays alive for the lifetime of the session/process. Whether it
  // pings is decided per-tick by evaluate(); "nothing to ping right now" never
  // ends the loop — it only schedules the next check. The loop exits only on
  // abort (a new prompt supersedes it, an explicit stop, or process death) or
  // when the session is not a parent (it should never have been started).
  async function run(sessionID: string, signal: AbortSignal, id: number) {
    while (!signal.aborted) {
      try {
        const next = await evaluate(sessionID)
        if (next.type === "stop") break
        // "ping" sleeps the exact time to the ping moment; "idle" backs off a
        // coarse tick and re-checks.
        await sleep(next.type === "ping" ? next.delay : IDLE_TICK, signal)
        if (signal.aborted) break
        if (next.type === "ping") await ping(sessionID, signal)
      } catch (e: any) {
        if (e.name === "AbortError") break
        log.error("ping loop error", { sessionID, error: e })
        await sleep(IDLE_TICK, signal).catch(() => {})
      }
    }
    // Only delete if we're still the active loop (not replaced by a newer one)
    const entry = active.get(sessionID)
    if (entry?.id === id) active.delete(sessionID)
  }

  type Next = { type: "ping"; delay: number } | { type: "idle" } | { type: "stop" }

  // Tri-state, never throws — read failures surface as "idle" so a transient
  // hiccup retries instead of killing the daemon.
  async function evaluate(sessionID: string): Promise<Next> {
    const session = await Session.get(sessionID).catch(() => undefined)
    if (!session) return { type: "idle" }
    // Subtasks/child sessions never ping; if one somehow started, stop it.
    if (session.parentID) return { type: "stop" }
    const base = session.cache?.lastRequestAt
    if (!base) return { type: "idle" } // no request dispatched yet this session
    const now = Date.now()
    if (base + CACHE_TTL <= now) return { type: "idle" } // cache expired — wait for next turn
    const target = base + CACHE_TTL - (await beforeExpiry())
    return { type: "ping", delay: Math.max(0, target - now) }
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
    const allMessages = [...stripped, { role: "user" as const, content: "." }]

    const tools = await SessionPrompt.resolveTools({
      agent,
      session,
      model,
      tools: lastUser.tools,
      processor: undefined as any,
      bypassAgentCheck: false,
      messages: msgs,
    })

    // Anchor the cache TTL to dispatch time — a ping is a real request that
    // restarts the 5m window, and (unlike an organic turn) it is never
    // persisted as a message, so the session anchor is the only record of it.
    const dispatchedAt = Date.now()
    await Session.update(sessionID, (draft) => {
      draft.ping = {
        count: draft.ping?.count ?? 0,
        time: draft.ping?.time ?? 0,
        pending: true,
      }
      draft.cache = { lastRequestAt: dispatchedAt }
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

    // Consume stream until finish-step to get usage metadata, then stop.
    // The finally clears `pending` on every exit path (abort, throw, or a
    // stream that ends without finish-step) so the TUI spinner can never be
    // orphaned in the "in flight" state.
    try {
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
            // count/time are ping telemetry; time records the dispatch moment,
            // not stream completion. The cache anchor was already stamped at
            // dispatch above.
            draft.ping = {
              count: (draft.ping?.count ?? 0) + 1,
              time: dispatchedAt,
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
    } finally {
      await Session.update(sessionID, (draft) => {
        if (draft.ping?.pending) draft.ping = { ...draft.ping, pending: false }
      })
    }
  }

  function sleep(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"))
      const timer = setTimeout(resolve, ms)
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer)
          reject(new DOMException("Aborted", "AbortError"))
        },
        { once: true },
      )
    })
  }
}
