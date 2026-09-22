import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"
import { Identifier } from "@/id/id"
import { Session } from "."
import { Agent } from "@/agent/agent"
import { Snapshot } from "@/snapshot"
import { SessionSummary } from "./summary"
import { Bus } from "@/bus"
import { SessionRecent } from "./recent"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { LLM } from "./llm"
import { Config } from "@/config/config"
import { SessionCompaction } from "./compaction"
import { SessionPing } from "./ping"
import { SessionPricing } from "./pricing"
import { PermissionNext } from "@/permission/next"
import { Question } from "@/question"
import { Image } from "@/image/image"
import { ABORTED, settled } from "@/util/abort"

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
        // Coalesce streaming text AND reasoning deltas for the LIVE BUS only:
        // buffer deltas and publish a combined one every flushMs so the UI streams
        // without one bus event per token. This never touches the DB — Level 2
        // persists a text/reasoning part exactly once, at its block-end event
        // below. 0 publishes per delta. Default 100ms is ~10 flushes/sec.
        const flushMs = cfg.experimental?.stream_flush_ms ?? 100
        // Persist an active text block to disk once it grows this far past its
        // last checkpoint, bounding what a hard crash (which never runs
        // persistActive) loses. Well above a normal block, so the common case
        // still persists once at block-end and Level 2's write budget holds.
        const CHECKPOINT_BYTES = 256 * 1024
        while (true) {
          // Per-iteration streaming state, hoisted above the try so persistActive
          // can flush and persist the active parts from both the post-loop drain
          // and the catch after an abort/error.
          let currentText: MessageV2.TextPart | undefined
          // Text length already checkpointed to disk for the active block, so a
          // long stream persists once per CHECKPOINT_BYTES rather than never
          // until block-end.
          let textPersisted = 0
          let reasoningMap: Record<string, MessageV2.ReasoningPart> = {}
          // The active reasoning part, buffered on the same timer as text so
          // extended thinking does not persist on every delta. Reasoning arrives
          // as a contiguous run per id, so one active part covers it.
          let currentReasoning: MessageV2.ReasoningPart | undefined
          // Pending (un-published) delta text for the active text and reasoning
          // parts, and the shared flush timer. flushStream publishes each buffer
          // as one combined delta to the bus — no persistence (Level 2 persists
          // at block-end).
          let pendingDelta = ""
          let pendingReasoning = ""
          let flushTimer: ReturnType<typeof setTimeout> | undefined
          const flushStream = () => {
            if (flushTimer) {
              clearTimeout(flushTimer)
              flushTimer = undefined
            }
            if (currentText && pendingDelta) {
              const delta = pendingDelta
              pendingDelta = ""
              Session.publishPart(currentText, delta)
            }
            if (currentReasoning && pendingReasoning) {
              const delta = pendingReasoning
              pendingReasoning = ""
              Session.publishPart(currentReasoning, delta)
            }
          }
          // Persist any active text/reasoning part that never reached its
          // block-end event — a stream that ends on `finish`/compaction, or an
          // abort/error mid-block. Under Level 2 nothing was persisted during the
          // stream, so without this the whole streamed block is lost on reload.
          // Drains to the bus first so the final text is published, then writes
          // once and clears the ref so a later path can't double-write it.
          const persistActive = async () => {
            flushStream()
            if (currentText) {
              const part = currentText
              currentText = undefined
              await Session.updatePart(part)
            }
            if (currentReasoning) {
              const part = currentReasoning
              currentReasoning = undefined
              await Session.updatePart(part)
            }
          }
          try {
            const buildTimer = log.time("llm.build")
            const { stream, cacheMarkers, systemBlockCount } = await LLM.stream(streamInput)
            buildTimer.stop()

            // Store cache markers and system block count on session for TUI display.
            // Anchor the cache TTL to request dispatch time (parent sessions only) —
            // every request that reaches Anthropic restarts the 5m cache window.
            const dispatchedAt = Date.now()
            // updateCache, not update: this fires once per step, so it broadcasts
            // the lean CacheUpdated event rather than the whole record. Only the
            // TUI reads these fields; the web dock takes its countdown from the
            // ping hub.
            await Session.updateCache(input.sessionID, (draft) => {
              draft.cacheMarkers = cacheMarkers
              draft.systemBlockCount = systemBlockCount
              if (!draft.parentID) draft.cache = { lastRequestAt: dispatchedAt }
            })
            // The cache TTL just reset, so the armed ping deadline moved with it.
            // Re-publish it now (event-driven) so the overview countdown tracks
            // the new anchor instead of drifting until the daemon's next wake.
            void SessionPing.refresh(input.sessionID)

            // Racing each step against the signal, rather than `for await`, is
            // what makes the teardown below reachable. A tool that never settles
            // (a wedged MCP server) leaves the SDK's stream suspended with no
            // further chunk and no end, so an iterator-driven loop parks inside
            // .next() forever: `throwIfAborted` never gets another turn, and the
            // part stays "running" for the life of the session.
            const iterator = stream.fullStream[Symbol.asyncIterator]()
            const aborted = settled(input.abort)
            using release = { [Symbol.dispose]: aborted.release }
            let firstChunk = true
            while (true) {
              const step = await Promise.race([iterator.next(), aborted.promise])
              // Abandon the suspended tool rather than await it: returning the
              // iterator would join the same call that is refusing to finish.
              if (step === ABORTED) {
                void iterator.return?.().catch(() => {})
                input.abort.throwIfAborted()
                break
              }
              if (step.done) break
              // Time-to-first-chunk isolates cloud latency (dispatch -> first
              // token) from the local build and per-step processing around it.
              if (firstChunk) {
                firstChunk = false
                log.info("llm.first-chunk", { duration: Date.now() - dispatchedAt })
              }
              const value = step.value
              input.abort.throwIfAborted()
              switch (value.type) {
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
                    if (!part.text) break
                    // A delta for a different reasoning id than the one buffered
                    // means the previous block is done streaming; drain it before
                    // switching, so its pending tail isn't attributed to this part.
                    if (currentReasoning && currentReasoning.id !== part.id) flushStream()
                    currentReasoning = part
                    if (flushMs <= 0) {
                      Session.publishPart(part, value.text)
                      break
                    }
                    pendingReasoning += value.text
                    if (!flushTimer) flushTimer = setTimeout(() => flushStream(), flushMs)
                  }
                  break

                case "reasoning-end":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    // Drain buffered reasoning deltas before the final full-part
                    // persist, so nothing streamed is dropped.
                    if (currentReasoning?.id === part.id) {
                      flushStream()
                      currentReasoning = undefined
                    }
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
                    if (value.output.attachments) await Image.clamp(value.output.attachments)
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
                  {
                    using _t = log.time("snapshot.track", { phase: "start-step" })
                    snapshot = await Snapshot.track()
                  }
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
                  // One pricing call feeds both the message cost and the session
                  // total, so they cannot drift apart.
                  const stepCost = await usage.cost
                  input.assistantMessage.cost += stepCost
                  input.assistantMessage.tokens = usage.tokens
                  const weightedInput = SessionPricing.weightedInput(usage.tokens)
                  const weightedOutput = usage.tokens.output + usage.tokens.reasoning
                  // updateTotals, not update: this fires once per step (and again
                  // for the parent of a subagent), so it broadcasts the lean
                  // TotalsUpdated event rather than the full session record. The
                  // live per-step token counts reach the client on the assistant
                  // message via message.updated; the session record uniquely holds
                  // the lifetime total/cost, which this carries.
                  const updated = await Session.updateTotals(input.sessionID, (draft) => {
                    draft.tokens.input = usage.tokens.input
                    draft.tokens.cacheRead = usage.tokens.cache.read
                    draft.tokens.cacheWrite = usage.tokens.cache.write
                    draft.tokens.output = usage.tokens.output
                    draft.tokens.reasoning = usage.tokens.reasoning
                    draft.tokens.cacheWrite5m = usage.tokens.cache.write5m ?? 0
                    draft.tokens.cacheWrite1h = usage.tokens.cache.write1h ?? 0
                    draft.total.input += weightedInput
                    draft.total.output += weightedOutput
                    draft.total.cacheWrite += usage.tokens.cache.write
                    draft.cost += stepCost
                  })
                  if (updated.parentID) {
                    await Session.updateTotals(updated.parentID, (draft) => {
                      draft.total.input += weightedInput
                      draft.total.output += weightedOutput
                      draft.total.cacheWrite += usage.tokens.cache.write
                      draft.cost += stepCost
                    })
                  }
                  let finishSnapshot: string | undefined
                  {
                    using _t = log.time("snapshot.track", { phase: "finish-step" })
                    finishSnapshot = await Snapshot.track()
                  }
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    reason: value.finishReason,
                    snapshot: finishSnapshot,
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "step-finish",
                    tokens: usage.tokens,
                    cost: stepCost,
                  })
                  await Session.updateMessage(input.assistantMessage)
                  if (snapshot) {
                    using _tp = log.time("snapshot.patch")
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
                  if (await SessionCompaction.isOverflow({ message: input.assistantMessage, model: input.model })) {
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
                  textPersisted = 0
                  break

                case "text-delta":
                  if (currentText) {
                    currentText.text += value.text
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    if (!currentText.text) break
                    // Checkpoint a very long block to disk so a hard crash
                    // (SIGKILL/OOM, which persistActive never runs for) loses at
                    // most CHECKPOINT_BYTES of streamed text, not the whole block.
                    // The threshold is high enough that an ordinary block still
                    // persists once, at block-end, keeping Level 2's write budget.
                    if (currentText.text.length - textPersisted >= CHECKPOINT_BYTES) {
                      textPersisted = currentText.text.length
                      await Session.updatePart(currentText)
                    }
                    if (flushMs <= 0) {
                      Session.publishPart(currentText, value.text)
                      break
                    }
                    pendingDelta += value.text
                    if (!flushTimer) flushTimer = setTimeout(() => flushStream(), flushMs)
                  }
                  break

                case "text-end":
                  if (currentText) {
                    // Drain any buffered deltas to the bus before the final
                    // full-part persist, so nothing streamed is dropped and the
                    // client's appended text matches the finalized part.
                    flushStream()
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
            // Full cloud span: dispatch -> stream end. Paired with llm.first-chunk
            // (dispatch -> first token), the difference is the streaming/generation
            // time, separate from the local build and per-step work.
            log.info("llm.stream-complete", { duration: Date.now() - dispatchedAt })
            // Persist any active part left when the stream ended without a
            // text-end/reasoning-end (finish event, or a break on compaction), so
            // its streamed text is not stranded unpersisted.
            await persistActive()
          } catch (e: any) {
            // An abort/error mid-block skips the block-end persist. Write the
            // partial text/reasoning before unwinding so a stopped turn keeps what
            // it streamed, rather than losing the whole block on reload (Level 2
            // persisted nothing during the stream). persistActive drains, writes
            // once, and clears the refs, so the timer can no longer target them.
            await persistActive().catch(() => {})
            log.error("process", {
              error: e,
              stack: JSON.stringify(e.stack),
            })
            const error = MessageV2.fromError(e, { providerID: input.model.providerID })
            const retry = SessionRetry.retryable(error)
            if (retry !== undefined && attempt < SessionRetry.RETRY_MAX_ATTEMPTS) {
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
            void SessionRecent.setError(input.assistantMessage.sessionID, true)
            Bus.publish(Session.Event.Error, {
              sessionID: input.assistantMessage.sessionID,
              error: input.assistantMessage.error,
            })
            // Clear the retry LABEL only. Busy stays true (the handle is still
            // in flight) until the loop unwinds through defer(cancel).
            SessionStatus.set(input.sessionID, { type: "idle" })
          }
          const postTimer = log.time("llm.post-stream")
          if (snapshot) {
            using _tp = log.time("snapshot.patch", { phase: "post-stream" })
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
          postTimer.stop()
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
