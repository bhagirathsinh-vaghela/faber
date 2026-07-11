import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"
import { Identifier } from "@/id/id"
import { Session } from "."
import { Agent } from "@/agent/agent"
import { Snapshot } from "@/snapshot"
import { SessionSummary } from "./summary"
import { Bus } from "@/bus"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { LLM } from "./llm"
import { Config } from "@/config/config"
import { SessionCompaction } from "./compaction"
import { PermissionNext } from "@/permission/next"
import { Question } from "@/question"

// Anthropic model cost rates ($/million tokens)
// https://docs.anthropic.com/en/docs/about-claude/models#model-comparison-table
const ANTHROPIC_COST_TIERS: Array<{
  match: (id: string) => boolean
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}> = [
  {
    match: (id) => id.includes("opus-4-0") || id.includes("opus-4-1"),
    input: 15,
    output: 75,
    cacheRead: 1.5,
    cacheWrite: 18.75,
  },
  { match: (id) => id.includes("opus"), input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { match: (id) => id.includes("sonnet"), input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  {
    match: (id) => id.includes("haiku-4-5") || id.includes("haiku-4.5"),
    input: 1,
    output: 5,
    cacheRead: 0.1,
    cacheWrite: 1.25,
  },
  { match: (id) => id.includes("haiku"), input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
]

export function computeStepCost(
  providerID: string,
  modelID: string,
  tokens: { input: number; output: number; cache: { read: number; write: number } },
): number {
  if (providerID !== "anthropic") return 0
  const tier = ANTHROPIC_COST_TIERS.find((t) => t.match(modelID))
  if (!tier) return 0
  return (
    (tokens.input / 1_000_000) * tier.input +
    (tokens.output / 1_000_000) * tier.output +
    (tokens.cache.read / 1_000_000) * tier.cacheRead +
    (tokens.cache.write / 1_000_000) * tier.cacheWrite
  )
}

export namespace SessionProcessor {
  const DOOM_LOOP_THRESHOLD = 3
  const log = Log.create({ service: "session.processor" })

  export type Info = Awaited<ReturnType<typeof create>>
  export type Result = Awaited<ReturnType<Info["process"]>>

  export function create(input: {
    assistantMessage: MessageV2.Assistant
    sessionID: string
    model: Provider.Model
    abort: AbortSignal
  }) {
    const toolcalls: Record<string, MessageV2.ToolPart> = {}
    let snapshot: string | undefined
    let blocked = false
    let attempt = 0
    let needsCompaction = false

    const result = {
      get message() {
        return input.assistantMessage
      },
      partFromToolCall(toolCallID: string) {
        return toolcalls[toolCallID]
      },
      async process(streamInput: LLM.StreamInput) {
        log.info("process")
        needsCompaction = false
        const cfg = await Config.get()
        const shouldBreak = cfg.experimental?.continue_loop_on_deny !== true
        // Coalesce streaming text deltas: instead of one SSE part event per token,
        // buffer deltas and publish a combined one every flushMs. The client appends
        // the combined delta identically to many small ones. 0 disables (publish per
        // delta). Default 80ms is ~12 flushes/sec, imperceptible while cutting the
        // per-token event envelope by the batch factor.
        const flushMs = cfg.experimental?.stream_flush_ms ?? 80
        while (true) {
          // Per-iteration streaming state, hoisted above the try so the catch can
          // tear down a pending flush timer after an abort/error.
          let currentText: MessageV2.TextPart | undefined
          let reasoningMap: Record<string, MessageV2.ReasoningPart> = {}
          // Pending (un-published) delta text for the active text part, and the
          // scheduled flush. flushText publishes the buffer as one combined delta.
          let pendingDelta = ""
          let flushTimer: ReturnType<typeof setTimeout> | undefined
          const flushText = async () => {
            if (flushTimer) {
              clearTimeout(flushTimer)
              flushTimer = undefined
            }
            if (!currentText || !pendingDelta) return
            const delta = pendingDelta
            pendingDelta = ""
            await Session.updatePart({ part: currentText, delta })
          }
          try {
            const { stream, cacheMarkers, systemBlockCount } = await LLM.stream(streamInput)

            // Store cache markers and system block count on session for TUI display.
            // Anchor the cache TTL to request dispatch time (parent sessions only) —
            // every request that reaches Anthropic restarts the 5m cache window.
            const dispatchedAt = Date.now()
            await Session.update(input.sessionID, (draft) => {
              draft.cacheMarkers = cacheMarkers
              draft.systemBlockCount = systemBlockCount
              if (!draft.parentID) draft.cache = { lastRequestAt: dispatchedAt }
            })

            for await (const value of stream.fullStream) {
              input.abort.throwIfAborted()
              switch (value.type) {
                case "start":
                  SessionStatus.set(input.sessionID, { type: "busy" })
                  break

                case "reasoning-start":
                  if (value.id in reasoningMap) {
                    continue
                  }
                  reasoningMap[value.id] = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "reasoning",
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  break

                case "reasoning-delta":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text += value.text
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    const signature = (value as any).providerMetadata?.anthropic?.signature as string | undefined
                    if (signature) part.signature = signature
                    if (part.text) await Session.updatePart({ part, delta: value.text })
                  }
                  break

                case "reasoning-end":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text = part.text.trimEnd()

                    part.time = {
                      ...part.time,
                      end: Date.now(),
                    }
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    await Session.updatePart(part)
                    delete reasoningMap[value.id]
                  }
                  break

                case "tool-input-start":
                  const part = await Session.updatePart({
                    id: toolcalls[value.id]?.id ?? Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "tool",
                    tool: value.toolName,
                    callID: value.id,
                    state: {
                      status: "pending",
                      input: {},
                      raw: "",
                    },
                  })
                  toolcalls[value.id] = part as MessageV2.ToolPart
                  break

                case "tool-input-delta":
                  break

                case "tool-input-end":
                  break

                case "tool-call": {
                  const match = toolcalls[value.toolCallId]
                  if (match) {
                    const part = await Session.updatePart({
                      ...match,
                      tool: value.toolName,
                      state: {
                        status: "running",
                        input: value.input,
                        time: {
                          start: Date.now(),
                        },
                      },
                      metadata: value.providerMetadata,
                    })
                    toolcalls[value.toolCallId] = part as MessageV2.ToolPart

                    const parts = await MessageV2.parts(input.assistantMessage.id)
                    const lastThree = parts.slice(-DOOM_LOOP_THRESHOLD)

                    if (
                      lastThree.length === DOOM_LOOP_THRESHOLD &&
                      lastThree.every(
                        (p) =>
                          p.type === "tool" &&
                          p.tool === value.toolName &&
                          p.state.status !== "pending" &&
                          JSON.stringify(p.state.input) === JSON.stringify(value.input),
                      )
                    ) {
                      const agent = await Agent.get(input.assistantMessage.agent)
                      await PermissionNext.ask({
                        permission: "doom_loop",
                        patterns: [value.toolName],
                        sessionID: input.assistantMessage.sessionID,
                        metadata: {
                          tool: value.toolName,
                          input: value.input,
                        },
                        always: [value.toolName],
                        ruleset: agent.permission,
                      })
                    }
                  }
                  break
                }
                case "tool-result": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "completed",
                        input: value.input ?? match.state.input,
                        output: value.output.output,
                        metadata: value.output.metadata,
                        title: value.output.title,
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                        attachments: value.output.attachments,
                      },
                    })

                    delete toolcalls[value.toolCallId]
                  }
                  break
                }

                case "tool-error": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "error",
                        input: value.input ?? match.state.input,
                        error: (value.error as any).toString(),
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                      },
                    })

                    if (
                      value.error instanceof PermissionNext.RejectedError ||
                      value.error instanceof Question.RejectedError
                    ) {
                      blocked = shouldBreak
                    }
                    delete toolcalls[value.toolCallId]
                  }
                  break
                }
                case "error":
                  throw value.error

                case "start-step":
                  snapshot = await Snapshot.track()
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.sessionID,
                    snapshot,
                    type: "step-start",
                  })
                  break

                case "finish-step":
                  const usage = Session.getUsage({
                    model: input.model,
                    usage: value.usage,
                    metadata: value.providerMetadata,
                  })
                  input.assistantMessage.finish = value.finishReason
                  input.assistantMessage.cost += usage.cost
                  input.assistantMessage.tokens = usage.tokens
                  const weightedInput = usage.tokens.cache.read * 0.1 + usage.tokens.cache.write * 1.25
                  const weightedOutput = usage.tokens.output + usage.tokens.reasoning
                  const stepCost = computeStepCost(input.model.providerID, input.model.id, usage.tokens)
                  const updated = await Session.update(input.sessionID, (draft) => {
                    draft.tokens.input = usage.tokens.input
                    draft.tokens.cacheRead = usage.tokens.cache.read
                    draft.tokens.cacheWrite = usage.tokens.cache.write
                    draft.tokens.output = usage.tokens.output
                    draft.tokens.reasoning = usage.tokens.reasoning
                    draft.total.input += weightedInput
                    draft.total.output += weightedOutput
                    draft.total.cacheWrite += usage.tokens.cache.write
                    draft.cost += stepCost
                  })
                  if (updated.parentID) {
                    await Session.update(updated.parentID, (draft) => {
                      draft.total.input += weightedInput
                      draft.total.output += weightedOutput
                      draft.total.cacheWrite += usage.tokens.cache.write
                      draft.cost += stepCost
                    })
                  }
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    reason: value.finishReason,
                    snapshot: await Snapshot.track(),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "step-finish",
                    tokens: usage.tokens,
                    cost: usage.cost,
                  })
                  await Session.updateMessage(input.assistantMessage)
                  if (snapshot) {
                    const patch = await Snapshot.patch(snapshot)
                    if (patch.files.length) {
                      await Session.updatePart({
                        id: Identifier.ascending("part"),
                        messageID: input.assistantMessage.id,
                        sessionID: input.sessionID,
                        type: "patch",
                        hash: patch.hash,
                        files: patch.files,
                      })
                    }
                    snapshot = undefined
                  }
                  SessionSummary.summarize({
                    sessionID: input.sessionID,
                    messageID: input.assistantMessage.parentID,
                  })
                  if (await SessionCompaction.isOverflow({ tokens: usage.tokens, model: input.model })) {
                    needsCompaction = true
                  }
                  break

                case "text-start":
                  currentText = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "text",
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  break

                case "text-delta":
                  if (currentText) {
                    currentText.text += value.text
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    if (!currentText.text) break
                    if (flushMs <= 0) {
                      await Session.updatePart({ part: currentText, delta: value.text })
                      break
                    }
                    pendingDelta += value.text
                    if (!flushTimer) flushTimer = setTimeout(() => void flushText(), flushMs)
                  }
                  break

                case "text-end":
                  if (currentText) {
                    // Drain any buffered deltas before the final full-part publish,
                    // so nothing streamed is dropped and the client's appended text
                    // matches the finalized part.
                    await flushText()
                    currentText.text = currentText.text.trimEnd()
                    const textOutput = await Plugin.trigger(
                      "experimental.text.complete",
                      {
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        partID: currentText.id,
                      },
                      { text: currentText.text },
                    )
                    currentText.text = textOutput.text
                    currentText.time = {
                      start: Date.now(),
                      end: Date.now(),
                    }
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    await Session.updatePart(currentText)
                  }
                  currentText = undefined
                  break

                case "finish":
                  break

                default:
                  log.info("unhandled", {
                    ...value,
                  })
                  continue
              }
              if (needsCompaction) break
            }
            // Drain any deltas buffered when the stream ended without a text-end
            // (finish event, or a break on compaction), so the tail isn't stranded.
            await flushText()
          } catch (e: any) {
            // A throw (abort included) skips the post-loop drain; kill the pending
            // timer so it can't fire a stale delta against a part that's ending.
            if (flushTimer) {
              clearTimeout(flushTimer)
              flushTimer = undefined
            }
            pendingDelta = ""
            log.error("process", {
              error: e,
              stack: JSON.stringify(e.stack),
            })
            const error = MessageV2.fromError(e, { providerID: input.model.providerID })
            const retry = SessionRetry.retryable(error)
            if (retry !== undefined) {
              attempt++
              const delay = SessionRetry.delay(attempt, error.name === "APIError" ? error : undefined)
              SessionStatus.set(input.sessionID, {
                type: "retry",
                attempt,
                message: retry,
                next: Date.now() + delay,
              })
              await SessionRetry.sleep(delay, input.abort).catch(() => {})
              continue
            }
            input.assistantMessage.error = error
            Bus.publish(Session.Event.Error, {
              sessionID: input.assistantMessage.sessionID,
              error: input.assistantMessage.error,
            })
            SessionStatus.set(input.sessionID, { type: "idle" })
          }
          if (snapshot) {
            const patch = await Snapshot.patch(snapshot)
            if (patch.files.length) {
              await Session.updatePart({
                id: Identifier.ascending("part"),
                messageID: input.assistantMessage.id,
                sessionID: input.sessionID,
                type: "patch",
                hash: patch.hash,
                files: patch.files,
              })
            }
            snapshot = undefined
          }
          const p = await MessageV2.parts(input.assistantMessage.id)
          for (const part of p) {
            if (part.type === "tool" && part.state.status !== "completed" && part.state.status !== "error") {
              await Session.updatePart({
                ...part,
                state: {
                  ...part.state,
                  status: "error",
                  error: "Tool execution aborted",
                  time: {
                    start: Date.now(),
                    end: Date.now(),
                  },
                },
              })
            }
          }
          input.assistantMessage.time.completed = Date.now()
          const completed = await Session.get(input.sessionID)
          input.assistantMessage.sessionTotal = { ...completed.total, cost: completed.cost }
          await Session.updateMessage(input.assistantMessage)
          if (needsCompaction) return "compact"
          if (blocked) return "stop"
          if (input.assistantMessage.error) return "stop"
          return "continue"
        }
      },
    }
    return result
  }
}
