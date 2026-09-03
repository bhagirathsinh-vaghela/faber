import path from "path"
import os from "os"
import fs from "fs/promises"
import z from "zod"
import { Identifier } from "../id/id"
import { MessageV2 } from "./message-v2"
import { Log } from "../util/log"
import { SessionRevert } from "./revert"
import { Session } from "."
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { type Tool as AITool, tool, jsonSchema, type ToolCallOptions, asSchema } from "ai"
import { SessionCompaction } from "./compaction"
import { Instance } from "../project/instance"
import { Vcs } from "../project/vcs"
import { OpenProjects } from "../project/open"
import { Global } from "../global"
import { Bus } from "../bus"
import { ProviderTransform } from "../provider/transform"
import { SystemPrompt } from "./system"
import { InstructionPrompt } from "./instruction"
import { Plugin } from "../plugin"
import PROMPT_PLAN from "../session/prompt/plan.txt"
import PROMPT_PLAN_SPARSE from "../session/prompt/plan-sparse.txt"
import PROMPT_PLAN_REENTRY from "../session/prompt/plan-reentry.txt"
import PROMPT_PLAN_SUBAGENT from "../session/prompt/plan-subagent.txt"
import BUILD_SWITCH from "../session/prompt/build-switch.txt"
import MAX_STEPS from "../session/prompt/max-steps.txt"
import SUBTASK from "../session/prompt/subtask.txt"
import { defer } from "../util/defer"
import { clone } from "remeda"
import { ToolRegistry } from "../tool/registry"
import { MCP } from "../mcp"
import { McpCatalog } from "../mcp/catalog"
import { AgentCatalog } from "../agent/catalog"
import { Config } from "../config/config"
import { LSP } from "../lsp"
import { ReadTool } from "../tool/read"
import { ListTool } from "../tool/ls"
import { FileTime } from "../file/time"
import { Flag } from "../flag/flag"
import { ulid } from "ulid"
import { spawn } from "child_process"
import { Command } from "../command"
import { $, fileURLToPath } from "bun"
import { ConfigMarkdown } from "../config/markdown"
import { SessionSummary } from "./summary"
import { Wildcard } from "../util/wildcard"
import { Filesystem } from "../util/filesystem"
import { NamedError } from "@opencode-ai/util/error"
import { fn } from "@/util/fn"
import { SessionProcessor } from "./processor"
import { TaskTool } from "@/tool/task"
import { Tool } from "@/tool/tool"
import { PermissionNext } from "@/permission/next"
import { Question } from "@/question"
import { SessionStatus } from "./status"
import { SessionBusy } from "./busy"
import { LLM } from "./llm"
import { SessionPing } from "./ping"
import { SessionPin } from "./pin"
import { iife } from "@/util/iife"
import { Shell } from "@/shell/shell"
import { Truncate } from "@/tool/truncation"
import { Image } from "@/image/image"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

export namespace SessionPrompt {
  const log = Log.create({ service: "session.prompt" })
  export const OUTPUT_TOKEN_MAX = Flag.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX || 32_000

  const state = Instance.state(
    () => {
      const data: Record<
        string,
        {
          abort: AbortController
          callbacks: {
            resolve(input: MessageV2.WithParts): void
            reject(reason?: any): void
          }[]
        }
      > = {}
      return data
    },
    async (current) => {
      for (const item of Object.values(current)) {
        item.abort.abort()
        for (const callback of item.callbacks) {
          callback.reject(new DOMException("Aborted", "AbortError"))
        }
      }
    },
  )

  // Each in-flight turn's parameters, claimed synchronously by its opener before
  // the opener's first await. A prompt that joins a running turn adopts these
  // instead of resolving its own, so one turn runs under one parameter set. The
  // slot is a Promise so a join arriving while the opener is still resolving
  // waits for it rather than racing to resolve in parallel.
  const turnParams = Instance.state(() => new Map<string, Promise<ReturnType<typeof MessageV2.inherit>>>())

  export function assertNotBusy(sessionID: string) {
    const match = state()[sessionID]
    if (match) throw new Session.BusyError(sessionID)
  }

  export const PromptInput = z.object({
    sessionID: Identifier.schema("session"),
    messageID: Identifier.schema("message").optional(),
    model: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
      })
      .optional(),
    agent: z.string().optional(),
    noReply: z.boolean().optional(),
    tools: z
      .record(z.string(), z.boolean())
      .optional()
      .describe(
        "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
      ),
    system: z.string().optional(),
    variant: z.string().optional(),
    parts: z.array(
      z.discriminatedUnion("type", [
        MessageV2.TextPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "TextPartInput",
          }),
        MessageV2.FilePart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "FilePartInput",
          }),
        MessageV2.AgentPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "AgentPartInput",
          }),
        MessageV2.SubtaskPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "SubtaskPartInput",
          }),
      ]),
    ),
  })
  export type PromptInput = z.infer<typeof PromptInput>

  export const prompt = fn(PromptInput, (input) => run(input))

  // The async route acks the moment the user message is durable, then lets the
  // turn run detached. onPersisted fires right after the message is written, so a
  // 204 means "message exists" and a client can trust a follow-up read of it.
  export function promptAsync(input: PromptInput, onPersisted: () => void | Promise<void>) {
    return run(input, onPersisted)
  }

  async function run(input: PromptInput, onPersisted?: () => void | Promise<void>) {
    // Claim the turn's parameters synchronously, before the first await, so two
    // prompts racing on an idle session cannot both resolve their own: the first
    // installs the slot, the second sees it and joins. The opener resolves the
    // slot once its message is built; a join awaits that. noReply writes a
    // message without running a turn, so it never claims.
    const claimed = !input.noReply && !turnParams().has(input.sessionID)
    let settleParams: ((params: ReturnType<typeof MessageV2.inherit>) => void) | undefined
    if (claimed) turnParams().set(input.sessionID, new Promise((resolve) => (settleParams = resolve)))
    const joinedParams = !claimed ? turnParams().get(input.sessionID) : undefined

    // The cache-ping daemon stays ARMED across the turn — we do NOT stop it here.
    // A turn that keeps dispatching model requests inside CACHE_TTL re-anchors the
    // cache faster than the daemon's scheduled ping, so evaluate() naturally keeps
    // the daemon quiet (its ping target slides past every dispatch). The daemon
    // only fires when a turn STALLS with no dispatch for longer than
    // CACHE_TTL - beforeExpiry — a blocking question, a long-running tool, or a
    // single slow model step — which is exactly the gap that used to let the cache
    // die mid-turn (footer "--" then a cache miss on resume). Keeping it armed
    // makes that stall self-heal. Any brief ping/turn overlap is safe: the cache
    // prefix is read-only shared state and lastRequestAt is last-writer-wins.
    const session = await Session.get(input.sessionID)
    // Arm the daemon at turn START, not just the tail. Sending a prompt is the
    // intended "keep this session" action, so it arms now — one lever (start()
    // arms and sets keepWarm as its shadow). This costs no ping: a busy turn
    // re-anchors the cache on every dispatch, sliding pingAt past now so the
    // armed daemon stays quiet; it fires ONLY if the turn stalls past a cache
    // window, which is exactly the mid-turn gap we want it to catch. The upshot
    // is the session reads warm the whole time it is busy, and a client that
    // Stopped it can't leave it cold once real work resumes.
    if (!session.parentID) SessionPing.start(session.id)
    // Adopt before any pin read (createUserMessage pins otherwise): a child
    // must share its parent's snapshot, not the current generation.
    if (session.parentID) SessionPin.adopt(session.id, session.parentID)
    await SessionRevert.cleanup(session)
    // Reset ping telemetry ({ count, time, pending }) for the new turn's display.
    // This is display state only (statusline's "N× pinged" / in-flight indicator);
    // it does not touch cache.lastRequestAt, so it never affects the cache clock.
    if (session.ping) {
      await Session.update(input.sessionID, (draft) => {
        draft.ping = undefined
      })
    }

    const message = await createUserMessage(input, joinedParams)
    if (settleParams) settleParams(MessageV2.inherit(message.info as MessageV2.User))
    await Session.touch(input.sessionID)
    await onPersisted?.()

    // this is backwards compatibility for allowing `tools` to be specified when
    // prompting
    const permissions: PermissionNext.Ruleset = []
    for (const [tool, enabled] of Object.entries(input.tools ?? {})) {
      permissions.push({
        permission: tool,
        action: enabled ? "allow" : "deny",
        pattern: "*",
      })
    }
    if (permissions.length > 0) {
      session.permission = permissions
      await Session.update(session.id, (draft) => {
        draft.permission = permissions
      })
    }

    if (input.noReply === true) {
      return message
    }

    return loop(input.sessionID)
  }

  export async function resolvePromptParts(template: string): Promise<PromptInput["parts"]> {
    const parts: PromptInput["parts"] = [
      {
        type: "text",
        text: template,
      },
    ]
    const files = ConfigMarkdown.files(template)
    const seen = new Set<string>()
    await Promise.all(
      files.map(async (match) => {
        const name = match[1]
        if (seen.has(name)) return
        seen.add(name)
        const filepath = name.startsWith("~/")
          ? path.join(os.homedir(), name.slice(2))
          : path.resolve(Instance.worktree, name)

        const stats = await fs.stat(filepath).catch(() => undefined)
        if (!stats) {
          const agent = await Agent.get(name)
          if (agent) {
            parts.push({
              type: "agent",
              name: agent.name,
            })
          }
          return
        }

        if (stats.isDirectory()) {
          parts.push({
            type: "file",
            url: `file://${filepath}`,
            filename: name,
            mime: "application/x-directory",
          })
          return
        }

        parts.push({
          type: "file",
          url: `file://${filepath}`,
          filename: name,
          mime: "text/plain",
        })
      }),
    )
    return parts
  }

  // Post-op file stamps a completed tool part contributes to FileTime.seed.
  // Two shapes exist because one filePath cannot describe a patch: single-file
  // tools stamp their own input path, while apply_patch persists a `stamps` list
  // covering every file it touched. A tool that writes files without emitting
  // one of these shapes is invisible to seed, so the next turn asks the model to
  // re-read a file it just wrote.
  export function fileStamps(part: MessageV2.Part) {
    if (part.type !== "tool" || part.state.status !== "completed") return []
    const meta = part.state.metadata
    if (Array.isArray(meta?.stamps))
      return meta.stamps.flatMap((stamp: { file?: unknown; mtime?: unknown; hash?: unknown }) =>
        typeof stamp?.file === "string" && typeof stamp.mtime === "number"
          ? [
              {
                file: Filesystem.resolve(Instance.directory, stamp.file),
                mtime: stamp.mtime,
                hash: typeof stamp.hash === "string" ? stamp.hash : undefined,
              },
            ]
          : [],
      )
    if (typeof part.state.input?.filePath !== "string" || typeof meta?.mtime !== "number") return []
    return [
      {
        file: Filesystem.resolve(Instance.directory, part.state.input.filePath),
        mtime: meta.mtime,
        hash: typeof meta.hash === "string" ? meta.hash : undefined,
        offset: typeof meta.offset === "number" ? meta.offset : undefined,
        limit: typeof meta.limit === "number" ? meta.limit : undefined,
      },
    ]
  }

  function start(sessionID: string) {
    const s = state()
    if (s[sessionID]) return
    const controller = new AbortController()
    s[sessionID] = {
      abort: controller,
      callbacks: [],
    }
    return controller.signal
  }

  export function cancel(sessionID: string) {
    log.info("cancel", { sessionID })
    const s = state()
    const match = s[sessionID]
    // The turn is over, so its parameter claim must go too — otherwise the next
    // fresh turn on this session would adopt the finished turn's parameters as a
    // phantom join.
    turnParams().delete(sessionID)
    // Both branches drop the session's open prompts. A prompt outlives the tool
    // call that raised it only as a dot nobody can answer, and the no-match
    // branch is reached with one still open: a session waiting on a permission
    // is not in-flight by the time a Stop arrives.
    void Question.clear(sessionID)
    void PermissionNext.clear(sessionID)
    if (!match) {
      // Disarming is never inferred from the absence of a handle: this branch
      // cannot tell an idle session apart from a turn whose handle a prior
      // cancel() already dropped, and every aborted turn reaches here twice
      // (route, then the loop's defer). Callers that mean "disarm" — /abort,
      // ping/stop, session delete — call SessionPing.stop themselves.
      SessionBusy.exit(sessionID)
      SessionStatus.set(sessionID, { type: "idle" })
      return
    }
    match.abort.abort()
    for (const item of match.callbacks) {
      item.reject(new DOMException("Aborted", "AbortError"))
    }
    delete s[sessionID]
    // The in-flight handle is gone — clear the derived busy (self + restamp
    // ancestors) and the retry detail. Both are now false.
    SessionBusy.exit(sessionID)
    SessionStatus.set(sessionID, { type: "idle" })
    return
  }

  export const loop = fn(Identifier.schema("session"), async (sessionID) => {
    const abort = start(sessionID)
    if (!abort) {
      return new Promise<MessageV2.WithParts>((resolve, reject) => {
        const callbacks = state()[sessionID].callbacks
        callbacks.push({ resolve, reject })
      })
    }

    using _ = defer(() => cancel(sessionID))

    let step = 0
    const session = await Session.get(sessionID)
    // Pin prompt-shaping state on the first turn after boot; child sessions
    // inherit the parent's pin so a config refresh mid-task can't split them.
    if (session.parentID) SessionPin.adopt(sessionID, session.parentID)
    // The in-flight handle now exists — derive busy (self + restamp ancestors,
    // seeding the child->parent edge). Paired with the defer(cancel) above,
    // which calls SessionBusy.exit on every loop exit.
    SessionBusy.enter(sessionID, session.parentID)
    const snapshot = await SessionPin.get(sessionID)
    while (true) {
      log.info("loop", { step, sessionID })
      if (abort.aborted) break
      let msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID))

      // Raise the ID floor to this session's newest message before minting any
      // new ids this turn. filterCompacted always keeps the tail, so the max id
      // here is the session's true newest. This stops a process whose wall clock
      // is behind the persisted ids (a backward step while the server was down)
      // from minting an assistant/part that sorts before its own parent — the
      // inversion that wedged the turn loop. Complements the link-based checks:
      // those survive an existing inversion, this prevents new ones.
      for (const msg of msgs) Identifier.seed(msg.info.id)

      // Rebuild the read-time map from durable history. Every tool that reads or
      // writes a file persists its post-op mtime+hash, so a file's entry reflects
      // the most recent access. That means a server restart restores prior reads
      // (no false "read it first" on edit), a compacted-away read is dropped so
      // the next Read returns real content instead of an unchanged stub, AND a
      // write in a prior turn carries its post-write mtime+hash forward instead
      // of the stale pre-write read state (which would make the guard fire on the
      // file this session just wrote).
      FileTime.seed(
        sessionID,
        msgs.flatMap((msg) => msg.parts.flatMap(fileStamps)),
      )

      // A compaction or subtask part is satisfied when a finished assistant
      // message links back to the message that holds it (both branches set the
      // assistant's parentID to that message's id). Keying "done" on this link
      // instead of on sort position makes it immune to ID inversion: a mis-timed
      // clock can reorder the summary before its own request, but the parentID
      // pointer is unchanged, so a completed task can never look pending again.
      const satisfied = new Set(
        msgs.flatMap((msg) => (msg.info.role === "assistant" && msg.info.finish ? [msg.info.parentID] : [])),
      )

      let lastUser: MessageV2.User | undefined
      let lastFinished: MessageV2.Assistant | undefined
      let tasks: (MessageV2.CompactionPart | MessageV2.SubtaskPart)[] = []
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]
        if (!lastUser && msg.info.role === "user") lastUser = msg.info as MessageV2.User
        if (!lastFinished && msg.info.role === "assistant" && msg.info.finish)
          lastFinished = msg.info as MessageV2.Assistant
        if (lastUser && lastFinished) break
        if (satisfied.has(msg.info.id)) continue
        const task = msg.parts.filter((part) => part.type === "compaction" || part.type === "subtask")
        tasks.push(...task)
      }

      if (!lastUser) throw new Error("No user message found in stream. This should never happen.")
      if (MessageV2.answered(msgs, lastUser.id)) {
        log.info("exiting loop", { sessionID })
        break
      }

      step++
      if (step === 1)
        ensureTitle({
          session,
          modelID: lastUser.model.modelID,
          providerID: lastUser.model.providerID,
          history: msgs,
        })

      const model = await Provider.getModel(lastUser.model.providerID, lastUser.model.modelID)
      const task = tasks.pop()

      // pending subtask
      // TODO: centralize "invoke tool" logic
      if (task?.type === "subtask") {
        const taskTool = await TaskTool.init()
        const taskModel = task.model ? await Provider.getModel(task.model.providerID, task.model.modelID) : model
        const assistantMessage = (await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          parentID: lastUser.id,
          sessionID,
          mode: task.agent,
          agent: task.agent,
          path: {
            cwd: Instance.directory,
            root: Instance.worktree,
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: taskModel.id,
          providerID: taskModel.providerID,
          time: {
            created: Date.now(),
          },
        })) as MessageV2.Assistant
        // Internal subtask path (no LLM to pick a toolset): map the agent name
        // to a built-in toolset, defaulting to "general" (full tools) for
        // custom agents, which preserves their pre-toolset unrestricted access.
        const toolsets = await Agent.toolsets()
        const toolset = toolsets[task.agent] ? task.agent : "general"
        let part = (await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistantMessage.id,
          sessionID: assistantMessage.sessionID,
          type: "tool",
          callID: ulid(),
          tool: TaskTool.id,
          state: {
            status: "running",
            input: {
              prompt: task.prompt,
              description: task.description,
              subagent_type: task.agent,
              toolset,
              command: task.command,
            },
            time: {
              start: Date.now(),
            },
          },
        })) as MessageV2.ToolPart
        const taskArgs = {
          prompt: task.prompt,
          description: task.description,
          subagent_type: task.agent,
          toolset,
          command: task.command,
        }
        await Plugin.trigger(
          "tool.execute.before",
          {
            tool: "task",
            sessionID,
            callID: part.id,
          },
          { args: taskArgs },
        )
        let executionError: Error | undefined
        const taskAgent = await Agent.get(task.agent)
        const taskCtx: Tool.Context = {
          agent: task.agent,
          messageID: assistantMessage.id,
          sessionID: sessionID,
          abort,
          callID: part.callID,
          extra: { bypassAgentCheck: true },
          messages: msgs,
          async metadata(input) {
            await Session.updatePart({
              ...part,
              type: "tool",
              state: {
                ...part.state,
                ...input,
              },
            } satisfies MessageV2.ToolPart)
          },
          async ask(req) {
            await PermissionNext.ask({
              ...req,
              sessionID: sessionID,
              ruleset: PermissionNext.merge(taskAgent.permission, session.permission ?? []),
            })
          },
        }
        const result = await taskTool.execute(taskArgs, taskCtx).catch((error) => {
          executionError = error
          log.error("subtask execution failed", { error, agent: task.agent, description: task.description })
          return undefined
        })
        await Plugin.trigger(
          "tool.execute.after",
          {
            tool: "task",
            sessionID,
            callID: part.id,
          },
          result,
        )
        assistantMessage.finish = "tool-calls"
        assistantMessage.time.completed = Date.now()
        await Session.updateMessage(assistantMessage)
        if (result && part.state.status === "running") {
          await Session.updatePart({
            ...part,
            state: {
              status: "completed",
              input: part.state.input,
              title: result.title,
              metadata: result.metadata,
              output: result.output,
              attachments: result.attachments,
              time: {
                ...part.state.time,
                end: Date.now(),
              },
            },
          } satisfies MessageV2.ToolPart)
        }
        if (!result) {
          await Session.updatePart({
            ...part,
            state: {
              status: "error",
              error: executionError ? `Tool execution failed: ${executionError.message}` : "Tool execution failed",
              time: {
                start: part.state.status === "running" ? part.state.time.start : Date.now(),
                end: Date.now(),
              },
              metadata: part.metadata,
              input: part.state.input,
            },
          } satisfies MessageV2.ToolPart)
        }

        if (task.command) {
          // Add synthetic user message to prevent certain reasoning models from erroring
          // If we create assistant messages w/ out user ones following mid loop thinking signatures
          // will be missing and it can cause errors for models like gemini for example
          const summaryUserMsg: MessageV2.User = {
            id: Identifier.ascending("message"),
            sessionID,
            role: "user",
            // Flagged on the message, not just its part: the reminder helpers
            // separate a turn the user opened from one the loop minted by
            // reading this field off the message.
            synthetic: true,
            time: {
              created: Date.now(),
            },
            ...MessageV2.inherit(lastUser),
          }
          await Session.updateMessage(summaryUserMsg)
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: summaryUserMsg.id,
            sessionID,
            type: "text",
            text: "Summarize the task tool output above and continue with your task.",
            synthetic: true,
            internal: true,
          } satisfies MessageV2.TextPart)
        }

        continue
      }

      // pending compaction
      if (task?.type === "compaction") {
        const compaction = await SessionCompaction.process({
          messages: msgs,
          parentID: lastUser.id,
          abort,
          sessionID,
        })
        if (compaction === "stop") break
        continue
      }

      // context overflow, needs compaction
      if (
        lastFinished &&
        lastFinished.summary !== true &&
        (await SessionCompaction.isOverflow({ tokens: lastFinished.tokens, model }))
      ) {
        await SessionCompaction.create({
          sessionID,
          agent: lastUser.agent,
          model: lastUser.model,
          auto: true,
        })
        continue
      }

      // normal processing
      const agent = snapshot.agents[lastUser.agent] ?? (await Agent.get(lastUser.agent))
      const maxSteps = agent.steps ?? Infinity
      const isLastStep = step >= maxSteps
      msgs = await insertReminders({
        messages: msgs,
        agent,
        session,
        model,
      })

      const processor = SessionProcessor.create({
        assistantMessage: (await Session.updateMessage({
          id: Identifier.ascending("message"),
          parentID: lastUser.id,
          role: "assistant",
          mode: agent.name,
          agent: agent.name,
          variant: lastUser.variant,
          path: {
            cwd: Instance.directory,
            root: Instance.worktree,
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: model.id,
          providerID: model.providerID,
          time: {
            created: Date.now(),
          },
          sessionID,
        })) as MessageV2.Assistant,
        sessionID: sessionID,
        model,
        abort,
      })
      using _ = defer(() => InstructionPrompt.clear(processor.message.id))

      // Check if user explicitly invoked an agent via @ in this turn
      const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
      const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false

      const tools = await resolveTools({
        agent,
        session,
        model,
        tools: lastUser.tools,
        processor,
        bypassAgentCheck,
        messages: msgs,
        snapshot,
      })

      if (step === 1) {
        SessionSummary.summarize({
          sessionID: sessionID,
          messageID: lastUser.id,
        })
      }

      const sessionMessages = clone(msgs)

      // Ephemerally wrap queued user messages with a reminder to stay on track
      if (step > 1 && lastFinished) {
        for (const msg of sessionMessages) {
          if (msg.info.role !== "user" || msg.info.id <= lastFinished.id) continue
          for (const part of msg.parts) {
            if (part.type !== "text" || part.ignored || part.synthetic) continue
            if (!part.text.trim()) continue
            part.text = [
              "<system-reminder>",
              "The user sent the following message:",
              part.text,
              "",
              "Please address this message and continue with your tasks.",
              "</system-reminder>",
            ].join("\n")
          }
        }
      }

      await Plugin.trigger("experimental.chat.messages.transform", {}, { messages: sessionMessages })

      const instructions = snapshot.instructions
      const variants = model.variants ?? ProviderTransform.variants(model)
      const variant = lastUser.variant ? variants[lastUser.variant] : undefined
      const stripReasoning =
        (model.api.npm === "@ai-sdk/anthropic" || model.api.npm === "@ai-sdk/google-vertex/anthropic") &&
        variant?.thinking?.type !== "enabled"
      // Read one-shot cache probe (index or message ID) and clear immediately
      const probeSession = await Session.get(sessionID)
      const cacheProbeIndex = probeSession?.cacheProbeIndex
      const cacheProbeMessageID = probeSession?.cacheProbeMessageID
      if (cacheProbeIndex !== undefined || cacheProbeMessageID !== undefined) {
        await Session.update(sessionID, (draft) => {
          draft.cacheProbeIndex = undefined
          draft.cacheProbeMessageID = undefined
        })
      }

      const result = await processor.process({
        user: lastUser,
        agent,
        abort,
        sessionID,
        system: {
          env: SystemPrompt.environment(),
          globalInstructions: instructions.global,
          projectInstructions: instructions.project,
          sessionContext: SystemPrompt.sessionContext({
            created: session.time.created,
            branch: session.branch,
          }),
        },
        ...(() => {
          const { messages, idToIndex } = MessageV2.toModelMessages(sessionMessages, model)
          const next = stripReasoning
            ? messages.map((msg) => {
                if (msg.role !== "assistant" || !Array.isArray(msg.content)) return msg
                return {
                  ...msg,
                  content: msg.content.filter((part) => part.type !== "reasoning"),
                }
              })
            : messages
          return {
            messages: [
              ...next,
              ...(isLastStep
                ? [
                    {
                      role: "assistant" as const,
                      content: MAX_STEPS,
                    },
                  ]
                : []),
            ],
            messageIdToIndex: idToIndex,
          }
        })(),
        sessionMessages,
        assistantMessage: processor.message,
        persistPromptIndex: true,
        tools,
        canAsk: canAsk(session),
        model,
        cacheProbeIndex,
        cacheProbeMessageID,
      })
      if (result === "stop") break
      if (result === "compact") {
        await SessionCompaction.create({
          sessionID,
          agent: lastUser.agent,
          model: lastUser.model,
          auto: true,
        })
      }
      continue
    }
    SessionCompaction.prune({ sessionID })
    if (!session.parentID) {
      // The daemon is already armed from turn start. On a clean finish leave it
      // armed (re-assert is a no-op) and mark unread. An aborted turn is torn
      // down elsewhere: a user Stop goes through the /abort route (stops the
      // daemon), and a superseding prompt re-arms via its own start(). So the
      // only thing the tail owns is markUnseen on completion.
      if (!abort.aborted) Session.markUnseen(sessionID)
      void OpenProjects.open({ id: Instance.project.id, worktree: Instance.worktree })
    }
    for await (const item of MessageV2.stream(sessionID)) {
      if (item.info.role === "user") continue
      const queued = state()[sessionID]?.callbacks ?? []
      for (const q of queued) {
        q.resolve(item)
      }
      return item
    }
    throw new Error("Impossible")
  })

  async function lastModel(sessionID: string) {
    return (await MessageV2.lastModel(sessionID)) ?? (await Provider.defaultModel())
  }

  // Tools that carry a file path we can scope against (the edit family).
  const PATH_SCOPED_TOOLS = ["edit", "write", "multiedit"]

  // Plan mode allowlist: every registered tool stays available (so the request
  // schema is identical to a build turn and the prompt cache survives the
  // plan<->build switch), but the edit-family tools are scoped to the plan files.
  // This replaces the old plan-agent edit permission deny, which routed through
  // PermissionNext.disabled and could strip edit tools from the wire.
  function planAllowlist(toolIds: string[]): Session.AllowedTool[] {
    const planPaths = [
      path.join(".opencode", "plans", "*.md"),
      path.relative(Instance.worktree, path.join(Global.Path.data, "plans", "*.md")),
      path.join(Global.Path.data, "plans", "*.md"),
    ]
    return toolIds.map((id) => (PATH_SCOPED_TOOLS.includes(id) ? { id, paths: planPaths } : id))
  }

  // Runtime gate for the allowedTools allowlist. Returns a denial message when
  // the tool call is not allowed, or undefined when it is. allowedTools never
  // removes a tool from the request schema (that would change the prompt-cache
  // prefix); the gate runs here at execution time instead.
  //   - allowedTools undefined        -> all tools allowed (normal sessions)
  //   - id absent from the list       -> denied
  //   - id present as a bare string   -> allowed, any arguments
  //   - id present as { id, paths }   -> allowed only when args.filePath
  //                                      matches a glob in paths
  //
  // `mcp` is passed ONLY when the caller is the MCP tool loop, marking `id` as a
  // dynamic MCP tool key whose grant may come from a class sentinel rather than
  // an exact-id match: Agent.MCP_WRITE grants any MCP tool, Agent.MCP_READ
  // grants one only when `mcp.readOnly` is true. Native tools pass no `mcp`, so
  // the sentinels are inert for them (a native id never equals a sentinel).
  export function toolDenial(
    allowed: Session.AllowedTool[] | undefined,
    id: string,
    args: any,
    mcp?: { readOnly: boolean },
  ): string | undefined {
    if (!allowed) return undefined
    if (mcp) {
      if (allowed.includes(Agent.MCP_WRITE)) return undefined
      if (mcp.readOnly && allowed.includes(Agent.MCP_READ)) return undefined
    }
    const entry = allowed.find((t) => (typeof t === "string" ? t === id : t.id === id))
    if (!entry) {
      const names = allowed.map((t) => (typeof t === "string" ? t : t.id))
      return `Tool "${id}" is not available for this task. Available tools: ${names.join(", ")}`
    }
    if (typeof entry === "string") return undefined
    if (!PATH_SCOPED_TOOLS.includes(id)) return undefined
    const filePath = args?.filePath
    if (typeof filePath !== "string") return `Tool "${id}" requires a file path for this task.`
    const target = path.isAbsolute(filePath) ? path.relative(Instance.worktree, filePath) : filePath
    if (entry.paths.some((p) => Wildcard.match(target, p) || Wildcard.match(filePath, p))) return undefined
    return `Tool "${id}" is restricted to ${entry.paths.join(", ")} for this task. "${filePath}" is not allowed.`
  }

  // Whether a session may call `question` this turn. Mirrors the allowlist the
  // runtime enforces, so the prompt fragment describing the tool ships only when
  // a call would actually succeed — a denied tool is still on the wire, so its
  // schema presence proves nothing.
  // Plan mode is not consulted: its derived allowlist carries every registered
  // tool, so only an explicit session allowlist (subtask, compaction) can deny.
  export function canAsk(session: Session.Info) {
    return toolDenial(session.allowedTools, "question", {}) === undefined
  }

  // Per-session MCP latch, enforced at execute time so tools[] stays
  // byte-identical whether or not a tool is disabled (gating via the wire would
  // churn the cache). MCP is always on; mcp_search is always available. An
  // individual MCP server tool is denied here iff its native name is in the
  // owning server's `disabled` config — the execution counterpart to corpus()
  // hiding it from the catalog. Returns a denial message the model can read, or
  // undefined when the tool is allowed.
  async function mcpDenied(id: string): Promise<string | undefined> {
    if (await MCP.isDisabled(id)) return `The "${id}" tool is disabled by configuration and cannot be used.`
    return undefined
  }

  export async function resolveTools(input: {
    agent: Agent.Info
    model: Provider.Model
    session: Session.Info
    tools?: Record<string, boolean>
    processor: SessionProcessor.Info
    bypassAgentCheck: boolean
    messages: MessageV2.WithParts[]
    snapshot?: SessionPin.Snapshot
  }) {
    using _ = log.time("resolveTools")
    const tools: Record<string, AITool> = {}

    const context = (args: any, options: ToolCallOptions): Tool.Context => ({
      sessionID: input.session.id,
      abort: options.abortSignal!,
      messageID: input.processor.message.id,
      callID: options.toolCallId,
      extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck },
      agent: input.agent.name,
      messages: input.messages,
      metadata: async (val: { title?: string; metadata?: any; delta?: string }) => {
        const match = input.processor.partFromToolCall(options.toolCallId)
        if (match && match.state.status === "running") {
          const part = {
            ...match,
            state: {
              title: val.title,
              metadata: val.metadata,
              status: "running" as const,
              input: args,
              time: {
                start: Date.now(),
              },
            },
          }
          // A tool that streams its output (bash, per chunk) passes the new chunk
          // as `delta`, so the wire blanks state.metadata.output and the client
          // appends. Without a delta the full part ships (seed + heal).
          await Session.updatePart(val.delta !== undefined ? { part, delta: val.delta } : part)
        }
      },
      async ask(req) {
        await PermissionNext.ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: PermissionNext.merge(input.agent.permission, input.session.permission ?? []),
        })
      },
    })

    const registered = await ToolRegistry.tools(
      { modelID: input.model.api.id, providerID: input.model.providerID },
      input.agent,
      input.snapshot,
    )
    // Effective allowlist: an explicit session allowlist (subtask/compaction)
    // wins; otherwise plan mode derives one that keeps every tool on the wire and
    // scopes edits to the plan files. Build agents get undefined (all allowed).
    const allowedTools =
      input.session.allowedTools ??
      (input.agent.name === "plan" ? planAllowlist(registered.map((item) => item.id)) : undefined)
    const ruleset = PermissionNext.merge(input.agent.permission, input.session.permission ?? [])
    const denied = PermissionNext.disabled(
      registered.map((item) => item.id),
      ruleset,
    )
    for (const item of registered) {
      if (denied.has(item.id)) continue
      const schema = ProviderTransform.schema(input.model, z.toJSONSchema(item.parameters))
      tools[item.id] = tool({
        id: item.id as any,
        description: item.description,
        inputSchema: jsonSchema(schema as any),
        async execute(args, options) {
          const ctx = context(args, options)
          const denial = toolDenial(allowedTools, item.id, args)
          if (denial) {
            return {
              title: item.id,
              metadata: {},
              output: denial,
            }
          }
          await Plugin.trigger(
            "tool.execute.before",
            {
              tool: item.id,
              sessionID: ctx.sessionID,
              callID: ctx.callID,
            },
            {
              args,
            },
          )
          const result = await item.execute(args, ctx)
          await Plugin.trigger(
            "tool.execute.after",
            {
              tool: item.id,
              sessionID: ctx.sessionID,
              callID: ctx.callID,
            },
            result,
          )
          return result
        },
      })
    }

    const mcpTitles = await MCP.titles()
    for (const [key, item] of Object.entries(await MCP.tools())) {
      const execute = item.execute
      if (!execute) continue

      const transformed = ProviderTransform.schema(input.model, asSchema(item.inputSchema).jsonSchema)
      item.inputSchema = jsonSchema(transformed)
      // Wrap execute to add plugin hooks and format output
      item.execute = async (args, opts) => {
        const ctx = context(args, opts)

        // Classify read/write only when the allowlist could grant MCP by the
        // read-only CLASS (an allowlist present, without the all-MCP sentinel).
        // The common paths — a root session (undefined) or a write grant — need
        // no classification, so they skip the lookup.
        const mcpClass =
          allowedTools && !allowedTools.includes(Agent.MCP_WRITE)
            ? { readOnly: await MCP.readOnly(key) }
            : { readOnly: false }
        const denial = (await mcpDenied(key)) ?? toolDenial(allowedTools, key, args, mcpClass)
        // The processor builds a completed tool part out of title/metadata/output,
        // so a content-only return fails ToolStateCompleted validation and aborts
        // the turn instead of showing the model why the call was refused.
        if (denial)
          return {
            title: mcpTitles[key] ?? key,
            metadata: {},
            output: denial,
            content: [{ type: "text" as const, text: denial }],
          }

        await Plugin.trigger(
          "tool.execute.before",
          {
            tool: key,
            sessionID: ctx.sessionID,
            callID: opts.toolCallId,
          },
          {
            args,
          },
        )

        await ctx.ask({
          permission: key,
          metadata: {},
          patterns: ["*"],
          always: ["*"],
        })

        const result = await execute(args, opts)

        await Plugin.trigger(
          "tool.execute.after",
          {
            tool: key,
            sessionID: ctx.sessionID,
            callID: opts.toolCallId,
          },
          result,
        )

        const textParts: string[] = []
        const attachments: MessageV2.FilePart[] = []

        for (const contentItem of result.content) {
          if (contentItem.type === "text") {
            textParts.push(contentItem.text)
          } else if (contentItem.type === "image") {
            attachments.push({
              id: Identifier.ascending("part"),
              sessionID: input.session.id,
              messageID: input.processor.message.id,
              type: "file",
              mime: contentItem.mimeType,
              url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
            })
          } else if (contentItem.type === "resource") {
            const { resource } = contentItem
            if (resource.text) {
              textParts.push(resource.text)
            }
            if (resource.blob) {
              attachments.push({
                id: Identifier.ascending("part"),
                sessionID: input.session.id,
                messageID: input.processor.message.id,
                type: "file",
                mime: resource.mimeType ?? "application/octet-stream",
                url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                filename: resource.uri,
              })
            }
          }
        }

        // A failed MCP tool call still returns a successful JSON-RPC envelope,
        // flagged only by isError. Without this it renders as a normal result
        // and the failure reads as an answer.
        if (result.isError) throw new Error(textParts.join("\n\n") || `${key} failed`)

        const truncated = await Truncate.output(textParts.join("\n\n"), {}, input.agent)
        const metadata = {
          ...(result.metadata ?? {}),
          truncated: truncated.truncated,
          ...(truncated.truncated && { outputPath: truncated.outputPath }),
        }

        return {
          title: mcpTitles[key] ?? "",
          metadata,
          output: truncated.content,
          attachments,
          content: result.content, // directly return content to preserve ordering when outputting to model
        }
      }
      tools[key] = item
    }

    return tools
  }

  async function createUserMessage(input: PromptInput, joined?: Promise<ReturnType<typeof MessageV2.inherit>>) {
    const snapshot = await SessionPin.get(input.sessionID)
    const agent =
      snapshot.agents[input.agent ?? snapshot.defaultAgent ?? ""] ??
      (await Agent.get(input.agent ?? (await Agent.defaultAgent())))
    // A prompt that joined a running turn adopts that turn's parameters — not the
    // picker values the client echoed since. Changing them is a conscious
    // idle-time act: interrupt, change, then send.
    const resolved = joined
      ? await joined
      : {
          agent: agent.name,
          model: input.model ?? (await lastModel(input.sessionID)) ?? agent.model,
          variant: input.variant ?? (await MessageV2.lastVariant(input.sessionID)) ?? agent.variant,
        }
    const info: MessageV2.User = {
      id: input.messageID ?? Identifier.ascending("message"),
      role: "user",
      sessionID: input.sessionID,
      time: {
        created: Date.now(),
      },
      tools: input.tools,
      system: input.system,
      ...resolved,
    }
    using _ = defer(() => InstructionPrompt.clear(info.id))

    const parts = await Promise.all(
      input.parts.map(async (part): Promise<MessageV2.Part[]> => {
        if (part.type === "file") {
          // before checking the protocol we check if this is an mcp resource because it needs special handling
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            log.info("mcp resource", { clientName, uri, mime: part.mime })

            const pieces: MessageV2.Part[] = [
              {
                id: Identifier.ascending("part"),
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]

            try {
              const resourceContent = await MCP.readResource(clientName, uri)
              if (!resourceContent) {
                throw new Error(`Resource not found: ${clientName}/${uri}`)
              }

              // Handle different content types
              const contents = Array.isArray(resourceContent.contents)
                ? resourceContent.contents
                : [resourceContent.contents]

              for (const content of contents) {
                if ("text" in content && content.text) {
                  pieces.push({
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: content.text as string,
                  })
                } else if ("blob" in content && content.blob) {
                  // Handle binary content if needed
                  const mimeType = "mimeType" in content ? content.mimeType : part.mime
                  pieces.push({
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary content: ${mimeType}]`,
                  })
                }
              }

              pieces.push({
                ...part,
                id: part.id ?? Identifier.ascending("part"),
                messageID: info.id,
                sessionID: input.sessionID,
              })
            } catch (error: unknown) {
              log.error("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                id: Identifier.ascending("part"),
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }

            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: Buffer.from(part.url, "base64url").toString(),
                  },
                  {
                    ...part,
                    id: part.id ?? Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                  },
                ]
              }
              break
            case "file:":
              log.info("file", { mime: part.mime })
              // have to normalize, symbol search returns absolute paths
              // Decode the pathname since URL constructor doesn't automatically decode it
              const filepath = fileURLToPath(part.url)
              const stat = await Bun.file(filepath).stat()

              if (stat.isDirectory()) {
                part.mime = "application/x-directory"
              }

              if (part.mime === "text/plain") {
                let offset: number | undefined = undefined
                let limit: number | undefined = undefined
                const range = {
                  start: url.searchParams.get("start"),
                  end: url.searchParams.get("end"),
                }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  // some LSP servers (eg, gopls) don't give full range in
                  // workspace/symbol searches, so we'll try to find the
                  // symbol in the document to get the full range
                  if (start === end) {
                    const symbols = await LSP.documentSymbol(filePathURI)
                    for (const symbol of symbols) {
                      let range: LSP.Range | undefined
                      if ("range" in symbol) {
                        range = symbol.range
                      } else if ("location" in symbol) {
                        range = symbol.location.range
                      }
                      if (range?.start?.line && range?.start?.line === start) {
                        start = range.start.line
                        end = range?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start - 1, 0)
                  if (end) {
                    limit = end - offset
                  }
                }
                const args = { filePath: filepath, offset, limit }

                const pieces: MessageV2.Part[] = [
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]

                await ReadTool.init()
                  .then(async (t) => {
                    const model = await Provider.getModel(info.model.providerID, info.model.modelID)
                    const readCtx: Tool.Context = {
                      sessionID: input.sessionID,
                      abort: new AbortController().signal,
                      agent: input.agent!,
                      messageID: info.id,
                      extra: { bypassCwdCheck: true, model },
                      messages: [],
                      metadata: async () => {},
                      ask: async () => {},
                    }
                    const result = await t.execute(args, readCtx)
                    pieces.push({
                      id: Identifier.ascending("part"),
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: result.output,
                    })
                    if (result.attachments?.length) {
                      pieces.push(
                        ...result.attachments.map((attachment) => ({
                          ...attachment,
                          synthetic: true,
                          filename: attachment.filename ?? part.filename,
                          messageID: info.id,
                          sessionID: input.sessionID,
                        })),
                      )
                    } else {
                      pieces.push({
                        ...part,
                        id: part.id ?? Identifier.ascending("part"),
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })
                    }
                  })
                  .catch((error) => {
                    log.error("failed to read file", { error })
                    const message = error instanceof Error ? error.message : error.toString()
                    Bus.publish(Session.Event.Error, {
                      sessionID: input.sessionID,
                      error: new NamedError.Unknown({
                        message,
                      }).toObject(),
                    })
                    pieces.push({
                      id: Identifier.ascending("part"),
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    })
                  })

                return pieces
              }

              if (part.mime === "application/x-directory") {
                const args = { path: filepath }
                const listCtx: Tool.Context = {
                  sessionID: input.sessionID,
                  abort: new AbortController().signal,
                  agent: input.agent!,
                  messageID: info.id,
                  extra: { bypassCwdCheck: true },
                  messages: [],
                  metadata: async () => {},
                  ask: async () => {},
                }
                const result = await ListTool.init().then((t) => t.execute(args, listCtx))
                return [
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the list tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  },
                  {
                    ...part,
                    id: part.id ?? Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                  },
                ]
              }

              const file = Bun.file(filepath)
              // Full read of the attached file, so stamp the real mtime + hash
              // (not a bare Date.now()) to keep a later edit from a spurious
              // re-read.
              await FileTime.restamp(input.sessionID, filepath)
              return [
                {
                  id: Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  text: `Called the Read tool with the following input: {\"filePath\":\"${filepath}\"}`,
                  synthetic: true,
                  internal: true,
                },
                {
                  id: part.id ?? Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url: `data:${part.mime};base64,` + Buffer.from(await file.bytes()).toString("base64"),
                  mime: part.mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
          }
        }

        if (part.type === "agent") {
          // Check if this agent would be denied by task permission
          const perm = PermissionNext.evaluate("task", part.name, agent.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            {
              id: Identifier.ascending("part"),
              ...part,
              messageID: info.id,
              sessionID: input.sessionID,
            },
            {
              id: Identifier.ascending("part"),
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              // An extra space is added here. Otherwise the 'Use' gets appended
              // to user's last word; making a combined word
              text:
                " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        return [
          {
            id: Identifier.ascending("part"),
            ...part,
            messageID: info.id,
            sessionID: input.sessionID,
          },
        ]
      }),
    ).then((x) => x.flat())

    await Image.clamp(parts)

    await Plugin.trigger(
      "chat.message",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        messageID: input.messageID,
        variant: input.variant,
      },
      {
        message: info,
        parts,
      },
    )

    // A message carrying nothing the user typed is the infrastructure talking
    // (the supervisor's resume prompt, a task result), and marking it here is
    // what keeps it out of the prompt count and out of every "last real user
    // message" lookup.
    if (parts.length > 0 && parts.every((part) => "synthetic" in part && part.synthetic)) info.synthetic = true

    // Stamped before the message is written so the ordinal is durable the
    // moment the prompt exists, rather than being recounted per turn from a
    // history that compaction shortens.
    if (!info.synthetic)
      info.ordinal = await Session.update(input.sessionID, (draft) => {
        draft.prompts = (draft.prompts ?? 0) + 1
      }).then((session) => session.prompts)

    await Session.updateMessage(info)
    for (const part of parts) {
      await Session.updatePart(part)
    }

    if (info.ordinal === 1) await placeholderTitle(input.sessionID, parts)

    return {
      info,
      parts,
    }
  }

  const PLAN_REMINDER_MARKER = "<!-- plan-mode-reminder -->"
  const PLAN_EXIT_MARKER = "<!-- plan-mode-exit -->"
  const SUBTASK_MARKER = "<!-- subtask-no-delegation -->"
  const CONCISE_MARKER = "<!-- concise-reminder -->"
  const CONCISE = "Keep replies concise: lead with the answer, no preamble, no recap."
  const TURNS_BETWEEN_REMINDERS = 5
  const FULL_REMINDER_EVERY_N = 5

  function hasPlanReminder(msg: MessageV2.WithParts) {
    return msg.parts.some((p) => p.type === "text" && p.synthetic && p.text.includes(PLAN_REMINDER_MARKER))
  }

  function hasPlanExit(msg: MessageV2.WithParts) {
    return msg.parts.some((p) => p.type === "text" && p.synthetic && p.text.includes(PLAN_EXIT_MARKER))
  }

  function hasSubtaskReminder(msg: MessageV2.WithParts) {
    return msg.parts.some((p) => p.type === "text" && p.synthetic && p.text.includes(SUBTASK_MARKER))
  }

  export function hasConciseReminder(msg: MessageV2.WithParts) {
    return msg.parts.some((p) => p.type === "text" && p.synthetic && p.text.includes(CONCISE_MARKER))
  }

  // The messages of the turn in flight: everything from the user's typed prompt
  // onward, so the synthetic user messages a turn mints along the way are in
  // scope while earlier turns are not.
  export function sinceLastPrompt(messages: MessageV2.WithParts[]) {
    const start = messages.findLastIndex((msg) => msg.info.role === "user" && !msg.info.synthetic)
    return start === -1 ? messages : messages.slice(start)
  }

  function planFileInfo(planPath: string, exists: boolean) {
    return exists
      ? `A plan file already exists at ${planPath}. You can read it and make incremental edits using the edit tool.`
      : `No plan file exists yet. You should create your plan at ${planPath} using the write tool.`
  }

  function planFileInfoSubagent(planPath: string, exists: boolean) {
    return exists
      ? `A plan file already exists at ${planPath}. You can read it and make incremental edits using the edit tool if you need to.`
      : `No plan file exists yet. You should create your plan at ${planPath} using the write tool if you need to.`
  }

  function renderTemplate(template: string, vars: Record<string, string>) {
    let result = template
    for (const [key, value] of Object.entries(vars)) result = result.replaceAll(key, value)
    return result
  }

  async function persistReminder(userMessage: MessageV2.WithParts, text: string, marker: string) {
    const userInfo = userMessage.info as MessageV2.User
    const wrapped = text.includes("<system-reminder>")
      ? `${marker}\n${text}`
      : `${marker}\n<system-reminder>\n${text}\n</system-reminder>`
    const part: MessageV2.TextPart = {
      id: Identifier.ascending("part"),
      messageID: userInfo.id,
      sessionID: userInfo.sessionID,
      type: "text",
      text: wrapped,
      synthetic: true,
      internal: true,
    }
    await Session.updatePart(part)
    userMessage.parts.push(part)
  }

  // Inject the progressive-disclosure MCP catalog as durable history when this
  // session's last-injected catalog no longer matches the catalog its instance
  // currently produces. The catalog text becomes a synthetic TextPart on the
  // latest user message and persists.
  //
  // Refresh model (MCP is always on; the catalog for a session is a pure function
  // of its INSTANCE — global+project servers, each server's `disabled` and tier,
  // and the connected set). Each session stores the catalog text it last injected
  // (mcpCatalogText); no version counter. Every turn:
  //   1. build the catalog for this instance and compare to mcpCatalogText.
  //      equal -> no-op (the common case).
  //   2. differ, new catalog empty (no servers / all disabled) -> store "" and
  //      append nothing.
  //   3. differ, new catalog non-empty -> append a FRESH FULL block at the tail
  //      and store it. Recency wins: the newest block supersedes any older one,
  //      which stays as inert history.
  //
  // Backfill: a pre-feature session has mcpCatalogText === undefined, treated as
  // "" -> a non-empty catalog injects on the next turn. Config changes take effect
  // on Stop->reopen (SessionPin.reset re-reads config AND resets MCP.state), which
  // rebuilds the corpus so the compare differs and re-injects.
  //
  // NOT wrapped in <system-reminder> (that would make provider/transform.ts
  // treat it as a meta message).
  async function insertMcpCatalog(input: { messages: MessageV2.WithParts[]; session: Session.Info }) {
    const catalog = McpCatalog.build(await MCP.corpus())

    // Already reflects the current instance catalog (incl. both being empty).
    if ((catalog ?? "") === (input.session.mcpCatalogText ?? "")) return

    // Nothing to show (no servers / everything disabled): record "" so we do not
    // rebuild-and-compare fruitlessly, append no block.
    if (!catalog) {
      await Session.update(input.session.id, (draft) => void (draft.mcpCatalogText = ""), { touch: false })
      input.session.mcpCatalogText = ""
      return
    }

    const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
    if (!userMessage) return
    const userInfo = userMessage.info as MessageV2.User
    const part: MessageV2.TextPart = {
      id: Identifier.ascending("part"),
      messageID: userInfo.id,
      sessionID: userInfo.sessionID,
      type: "text",
      text: catalog,
      synthetic: true,
      internal: true,
    }
    await Session.updatePart(part)
    userMessage.parts.push(part)
    await Session.update(input.session.id, (draft) => void (draft.mcpCatalogText = catalog), { touch: false })
    input.session.mcpCatalogText = catalog
  }

  // Repo-scoped subagents ride here instead of in the task tool's description,
  // which sits in tools[] ahead of every cache marker (see AgentCatalog). The
  // block is appended once per session and then carried as durable history.
  async function insertAgentCatalog(input: { messages: MessageV2.WithParts[]; session: Session.Info }) {
    // A subtask cannot spawn another subtask, so the list would be dead weight
    // in its prompt, and a subtask started without include_context is meant to
    // begin from a blank conversation.
    if (input.session.parentID) return
    const scoped = await Config.projectAgents()
    if (scoped.size === 0) return
    const agents = (await Agent.list()).filter((a) => a.mode !== "primary" && scoped.has(a.name))
    const catalog = AgentCatalog.build(agents)
    if (!catalog) return

    const present = input.messages.some((msg) =>
      msg.parts.some((part) => part.type === "text" && part.text.startsWith("<project_subagents>")),
    )
    if (present) return

    const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
    if (!userMessage) return
    const userInfo = userMessage.info as MessageV2.User
    const part: MessageV2.TextPart = {
      id: Identifier.ascending("part"),
      messageID: userInfo.id,
      sessionID: userInfo.sessionID,
      type: "text",
      text: catalog,
      // Written for the model and appended to the USER'S OWN message, so
      // without this the transcript draws the catalog where the typed prompt
      // should be.
      internal: true,
      synthetic: true,
    }
    await Session.updatePart(part)
    userMessage.parts.push(part)
  }

  // Announce a date or branch that has moved since the model was last told. The
  // frozen session-context block sits ahead of the whole conversation, so
  // correcting it in place would re-hash every block behind it; a block at the
  // tail states the new value and leaves the cached prefix untouched. Both facts
  // ride one block, so a turn that crosses midnight on a new branch appends once.
  async function insertSessionContext(input: { messages: MessageV2.WithParts[]; session: Session.Info }) {
    const date = SystemPrompt.date()
    // session.branch is fixed at creation, so a switch is only visible by asking
    // Vcs, which serves a value it keeps current from a watcher rather than
    // shelling out per turn. A read failure returns undefined, which carries no
    // information: hold the last known branch rather than announcing a move to
    // nothing, which would emit an empty block and forget the real branch.
    const live = Instance.project.vcs === "git" ? await Vcs.branch() : undefined
    const branch = live ?? input.session.contextBranch ?? input.session.branch
    // Seed both dimensions from what the frozen block already stated (the
    // creation-time values), so a value that never moved announces nothing.
    const known = {
      date: input.session.contextDate ?? SystemPrompt.date(input.session.time.created),
      branch: input.session.contextBranch ?? input.session.branch,
    }
    if (known.date === date && known.branch === branch) return

    const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
    if (!userMessage) return
    const text = SystemPrompt.sessionContextUpdate({
      date: known.date === date ? undefined : date,
      branch: known.branch === branch ? undefined : branch,
    })
    const userInfo = userMessage.info as MessageV2.User
    const part: MessageV2.TextPart = {
      id: Identifier.ascending("part"),
      messageID: userInfo.id,
      sessionID: userInfo.sessionID,
      type: "text",
      text,
      // Machinery, and it lands on the USER'S OWN message rather than a
      // message of its own. The transcript picks one part to draw per message,
      // so without this flag a block written for the model is chosen over the
      // prompt the user typed, and the typed text becomes unreachable.
      internal: true,
      synthetic: true,
    }
    await Session.updatePart(part)
    userMessage.parts.push(part)
    await Session.update(
      input.session.id,
      (draft) => {
        draft.contextDate = date
        draft.contextBranch = branch
      },
      { touch: false },
    )
    input.session.contextDate = date
    input.session.contextBranch = branch
  }

  async function insertReminders(input: {
    messages: MessageV2.WithParts[]
    agent: Agent.Info
    session: Session.Info
    model: Provider.Model
  }) {
    await insertMcpCatalog(input)
    await insertAgentCatalog(input)
    await insertSessionContext(input)

    const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
    if (!userMessage) return input.messages

    // The concision rules live in the cached system prompt, which a long turn
    // drifts from; re-stating the shape each turn is what holds it. Appending
    // to the newest message keeps the prefix behind it byte-identical. A
    // subtask's output is read by its parent model, not the user, so terseness
    // tuned for a human reader would cost the parent detail.
    //
    // Presence is checked from the typed prompt onward, not on the message
    // being appended to: a task summary or a compaction mints a fresh user
    // message mid-turn, and a per-message check would inject once more for
    // each one, rewriting the tail every time.
    //
    // The append target itself is also checked directly, so the guard holds
    // even if the window ever stops covering it — a second append onto a
    // message already sent would rewrite the prefix behind the rolling marker.
    const carried = hasConciseReminder(userMessage) || sinceLastPrompt(input.messages).some(hasConciseReminder)
    if (!input.session.parentID && !carried) {
      const concise = (await Config.get()).concise?.[`${input.model.providerID}/${input.model.id}`]
      if (concise) await persistReminder(userMessage, CONCISE, CONCISE_MARKER)
    }

    // A subtask reaches for the task tool, gets a denial back, and only then
    // does the work itself, having spent a turn learning it. The tool stays in
    // the schema either way (removing it would move the tools[] bytes the whole
    // prefix hashes), so the cheap fix is telling it up front.
    //
    // It rides the FIRST user message and is written once for the session: the
    // fact never changes, and a block appended to each new turn would rewrite
    // the tail of the prefix every time. Presence is checked across the whole
    // conversation, not just the message being answered, since later turns
    // carry their own fresh message.
    if (input.session.parentID && !input.messages.some(hasSubtaskReminder)) {
      const first = input.messages.find((msg) => msg.info.role === "user") ?? userMessage
      await persistReminder(first, SUBTASK, SUBTASK_MARKER)
    }

    const plan = Session.plan(input.session)
    const exists = await Bun.file(plan).exists()

    // Switching from plan mode to build mode
    const lastAssistant = input.messages.findLast((msg) => msg.info.role === "assistant")
    if (input.agent.name !== "plan" && lastAssistant?.info.agent === "plan") {
      const exitText = renderTemplate(BUILD_SWITCH, {
        "${PLAN_FILE_INFO_EXIT}": exists ? ` The plan file is located at ${plan} if you need to reference it.` : "",
      })
      await persistReminder(userMessage, exitText, PLAN_EXIT_MARKER)
      return input.messages
    }

    // Not in plan mode — check if this is a sub-agent whose parent is in plan mode
    if (input.agent.name !== "plan") {
      if (input.session.parentID && !hasPlanReminder(userMessage)) {
        const parentMsgs = await Session.messages({ sessionID: input.session.parentID })
        const parentLastUser = parentMsgs.findLast((m) => m.info.role === "user" && !m.info.synthetic)
        if (parentLastUser && (parentLastUser.info as MessageV2.User).agent === "plan") {
          const parentSession = await Session.get(input.session.parentID)
          const parentPlan = Session.plan(parentSession)
          const parentPlanExists = await Bun.file(parentPlan).exists()
          const subagentText = renderTemplate(PROMPT_PLAN_SUBAGENT, {
            "${PLAN_FILE_INFO_SUBAGENT}": planFileInfoSubagent(parentPlan, parentPlanExists),
          })
          await persistReminder(userMessage, subagentText, PLAN_REMINDER_MARKER)
        }
      }
      return input.messages
    }

    // In plan mode — check if we need to inject a reminder
    if (!exists) await fs.mkdir(path.dirname(plan), { recursive: true })

    // Check if this user message already has a plan reminder (e.g. from a previous loop iteration)
    if (hasPlanReminder(userMessage)) return input.messages

    // Count assistant turns since last plan reminder and total reminders since last exit
    let turnsSinceReminder = 0
    let totalReminders = 0
    let hadPlanExit = false
    for (let i = input.messages.length - 1; i >= 0; i--) {
      const msg = input.messages[i]
      if (msg.info.role === "user" && hasPlanExit(msg)) {
        hadPlanExit = true
        break
      }
      if (msg.info.role === "user" && hasPlanReminder(msg)) {
        break
      }
      if (msg.info.role === "assistant") {
        turnsSinceReminder++
      }
    }
    // Count total plan reminders since last exit for full/sparse cycling
    for (let i = input.messages.length - 1; i >= 0; i--) {
      const msg = input.messages[i]
      if (msg.info.role === "user" && hasPlanExit(msg)) break
      if (msg.info.role === "user" && hasPlanReminder(msg)) totalReminders++
    }

    const isEnteringPlan = !lastAssistant || lastAssistant.info.agent !== "plan"

    // Re-entry: entering plan mode again after a previous exit, with an existing plan file
    if (isEnteringPlan && hadPlanExit && exists) {
      const reentryText = renderTemplate(PROMPT_PLAN_REENTRY, { "${PLAN_FILE_PATH}": plan })
      await persistReminder(userMessage, reentryText, PLAN_REMINDER_MARKER)
    }

    // First entry or re-entry: always inject full reminder
    if (isEnteringPlan) {
      const fullText = renderTemplate(PROMPT_PLAN, { "${PLAN_FILE_INFO}": planFileInfo(plan, exists) })
      await persistReminder(userMessage, fullText, PLAN_REMINDER_MARKER)
      return input.messages
    }

    // Continuing in plan mode — periodic injection
    if (turnsSinceReminder < TURNS_BETWEEN_REMINDERS) return input.messages

    // Determine full vs sparse: full on 1st, every Nth after
    const isFull = (totalReminders + 1) % FULL_REMINDER_EVERY_N === 1
    if (isFull) {
      const fullText = renderTemplate(PROMPT_PLAN, { "${PLAN_FILE_INFO}": planFileInfo(plan, exists) })
      await persistReminder(userMessage, fullText, PLAN_REMINDER_MARKER)
    } else {
      const sparseText = renderTemplate(PROMPT_PLAN_SPARSE, { "${PLAN_FILE_PATH}": plan })
      await persistReminder(userMessage, sparseText, PLAN_REMINDER_MARKER)
    }

    return input.messages
  }

  export const ShellInput = z.object({
    messageID: Identifier.schema("message").optional(),
    sessionID: Identifier.schema("session"),
    agent: z.string(),
    model: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
      })
      .optional(),
    command: z.string(),
  })
  export type ShellInput = z.infer<typeof ShellInput>
  export async function shell(input: ShellInput) {
    const abort = start(input.sessionID)
    if (!abort) {
      throw new Session.BusyError(input.sessionID)
    }
    using _ = defer(() => cancel(input.sessionID))

    const session = await Session.get(input.sessionID)
    if (session.revert) {
      await SessionRevert.cleanup(session)
    }
    const agent = (await SessionPin.get(input.sessionID)).agents[input.agent] ?? (await Agent.get(input.agent))
    const model = input.model ?? agent.model ?? (await lastModel(input.sessionID))
    const userMsg: MessageV2.User = {
      id: input.messageID ?? Identifier.ascending("message"),
      sessionID: input.sessionID,
      time: {
        created: Date.now(),
      },
      role: "user",
      agent: input.agent,
      model: {
        providerID: model.providerID,
        modelID: model.modelID,
      },
      variant: await MessageV2.lastVariant(input.sessionID),
    }
    await Session.updateMessage(userMsg)
    const userPart: MessageV2.Part = {
      type: "text",
      id: Identifier.ascending("part"),
      messageID: userMsg.id,
      sessionID: input.sessionID,
      text: "The following tool was executed by the user",
      synthetic: true,
    }
    await Session.updatePart(userPart)

    const msg: MessageV2.Assistant = {
      id: Identifier.ascending("message"),
      sessionID: input.sessionID,
      parentID: userMsg.id,
      mode: input.agent,
      agent: input.agent,
      cost: 0,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      time: {
        created: Date.now(),
      },
      role: "assistant",
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: model.modelID,
      providerID: model.providerID,
    }
    await Session.updateMessage(msg)
    const part: MessageV2.Part = {
      type: "tool",
      id: Identifier.ascending("part"),
      messageID: msg.id,
      sessionID: input.sessionID,
      tool: "bash",
      callID: ulid(),
      state: {
        status: "running",
        time: {
          start: Date.now(),
        },
        input: {
          command: input.command,
        },
      },
    }
    await Session.updatePart(part)
    const shell = Shell.preferred()
    const shellName = (
      process.platform === "win32" ? path.win32.basename(shell, ".exe") : path.basename(shell)
    ).toLowerCase()

    const invocations: Record<string, { args: string[] }> = {
      nu: {
        args: ["-c", input.command],
      },
      fish: {
        args: ["-c", input.command],
      },
      zsh: {
        args: [
          "-c",
          "-l",
          `
            [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
            [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
            eval ${JSON.stringify(input.command)}
          `,
        ],
      },
      bash: {
        args: [
          "-c",
          "-l",
          `
            shopt -s expand_aliases
            [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
            eval ${JSON.stringify(input.command)}
          `,
        ],
      },
      // Windows cmd
      cmd: {
        args: ["/c", input.command],
      },
      // Windows PowerShell
      powershell: {
        args: ["-NoProfile", "-Command", input.command],
      },
      pwsh: {
        args: ["-NoProfile", "-Command", input.command],
      },
      // Fallback: any shell that doesn't match those above
      //  - No -l, for max compatibility
      "": {
        args: ["-c", `${input.command}`],
      },
    }

    const matchingInvocation = invocations[shellName] ?? invocations[""]
    const args = matchingInvocation?.args

    const cwd = Instance.directory
    const shellEnv = await Plugin.trigger("shell.env", { cwd }, { env: {} })
    const proc = spawn(shell, args, {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...shellEnv.env,
        TERM: "dumb",
      },
    })

    let output = ""

    proc.stdout?.on("data", (chunk) => {
      output += chunk.toString()
      if (part.state.status === "running") {
        part.state.metadata = {
          output: output,
          description: "",
        }
        Session.updatePart(part)
      }
    })

    proc.stderr?.on("data", (chunk) => {
      output += chunk.toString()
      if (part.state.status === "running") {
        part.state.metadata = {
          output: output,
          description: "",
        }
        Session.updatePart(part)
      }
    })

    let aborted = false
    let exited = false

    const kill = () => Shell.killTree(proc, { exited: () => exited })

    if (abort.aborted) {
      aborted = true
      await kill()
    }

    const abortHandler = () => {
      aborted = true
      void kill()
    }

    abort.addEventListener("abort", abortHandler, { once: true })

    await new Promise<void>((resolve) => {
      proc.on("close", () => {
        exited = true
        abort.removeEventListener("abort", abortHandler)
        resolve()
      })
    })

    if (aborted) {
      output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
    }
    msg.time.completed = Date.now()
    await Session.updateMessage(msg)
    if (part.state.status === "running") {
      part.state = {
        status: "completed",
        time: {
          ...part.state.time,
          end: Date.now(),
        },
        input: part.state.input,
        title: "",
        metadata: {
          output,
          description: "",
        },
        output,
      }
      await Session.updatePart(part)
    }
    return { info: msg, parts: [part] }
  }

  export const CommandInput = z.object({
    messageID: Identifier.schema("message").optional(),
    sessionID: Identifier.schema("session"),
    agent: z.string().optional(),
    model: z.string().optional(),
    arguments: z.string(),
    command: z.string(),
    variant: z.string().optional(),
    parts: z
      .array(
        z.discriminatedUnion("type", [
          MessageV2.FilePart.omit({
            messageID: true,
            sessionID: true,
          }).partial({
            id: true,
          }),
        ]),
      )
      .optional(),
  })
  export type CommandInput = z.infer<typeof CommandInput>
  const bashRegex = /!`([^`]+)`/g
  // Match [Image N] as single token, quoted strings, or non-space sequences
  const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
  const placeholderRegex = /\$(\d+)/g
  const quoteTrimRegex = /^["']|["']$/g
  /**
   * Regular expression to match @ file references in text
   * Matches @ followed by file paths, excluding commas, periods at end of sentences, and backticks
   * Does not match when preceded by word characters or backticks (to avoid email addresses and quoted references)
   */

  export async function command(input: CommandInput) {
    log.info("command", input)
    const snapshot = await SessionPin.get(input.sessionID)
    const command = snapshot.commands[input.command] ?? (await Command.get(input.command))
    const agentName = command.agent ?? input.agent ?? snapshot.defaultAgent ?? (await Agent.defaultAgent())

    const raw = input.arguments.match(argsRegex) ?? []
    const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))

    const templateCommand = await command.template

    const placeholders = templateCommand.match(placeholderRegex) ?? []
    let last = 0
    for (const item of placeholders) {
      const value = Number(item.slice(1))
      if (value > last) last = value
    }

    // Let the final placeholder swallow any extra arguments so prompts read naturally
    const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
      const position = Number(index)
      const argIndex = position - 1
      if (argIndex >= args.length) return ""
      if (position === last) return args.slice(argIndex).join(" ")
      return args[argIndex]
    })
    const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
    let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

    // If command doesn't explicitly handle arguments (no $N or $ARGUMENTS placeholders)
    // but user provided arguments, append them to the template
    if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
      template = template + "\n\n" + input.arguments
    }

    // Substituted ahead of the shell expansion below so a !`...` block can pass
    // the id to a command; the model has no other way to learn which session it is.
    template = template.replaceAll("$SESSION", input.sessionID)

    const shell = ConfigMarkdown.shell(template)
    if (shell.length > 0) {
      const results = await Promise.all(
        shell.map(async ([, cmd]) => {
          try {
            return await $`${{ raw: cmd }}`.quiet().nothrow().text()
          } catch (error) {
            return `Error executing command: ${error instanceof Error ? error.message : String(error)}`
          }
        }),
      )
      let index = 0
      template = template.replace(bashRegex, () => results[index++])
    }
    template = template.trim()

    const taskModel = await (async () => {
      if (command.model) {
        return Provider.parseModel(command.model)
      }
      if (command.agent) {
        const cmdAgent = snapshot.agents[command.agent] ?? (await Agent.get(command.agent))
        if (cmdAgent?.model) {
          return cmdAgent.model
        }
      }
      if (input.model) return Provider.parseModel(input.model)
      return await lastModel(input.sessionID)
    })()

    try {
      await Provider.getModel(taskModel.providerID, taskModel.modelID)
    } catch (e) {
      if (Provider.ModelNotFoundError.isInstance(e)) {
        const { providerID, modelID, suggestions } = e.data
        const hint = suggestions?.length ? ` Did you mean: ${suggestions.join(", ")}?` : ""
        Bus.publish(Session.Event.Error, {
          sessionID: input.sessionID,
          error: new NamedError.Unknown({ message: `Model not found: ${providerID}/${modelID}.${hint}` }).toObject(),
        })
      }
      throw e
    }
    const agent = snapshot.agents[agentName] ?? (await Agent.get(agentName))
    if (!agent) {
      const available = await Agent.list().then((agents) => agents.filter((a) => !a.hidden).map((a) => a.name))
      const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
      const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
      Bus.publish(Session.Event.Error, {
        sessionID: input.sessionID,
        error: error.toObject(),
      })
      throw error
    }

    const templateParts = await resolvePromptParts(template)
    const isSubtask = (agent.mode === "subagent" && command.subtask !== false) || command.subtask === true
    const parts = isSubtask
      ? [
          {
            type: "subtask" as const,
            agent: agent.name,
            description: command.description ?? "",
            command: input.command,
            model: {
              providerID: taskModel.providerID,
              modelID: taskModel.modelID,
            },
            // TODO: how can we make task tool accept a more complex input?
            prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
          },
        ]
      : [...templateParts, ...(input.parts ?? [])]

    const userAgent = isSubtask ? (input.agent ?? snapshot.defaultAgent ?? (await Agent.defaultAgent())) : agentName
    const userModel = isSubtask
      ? input.model
        ? Provider.parseModel(input.model)
        : await lastModel(input.sessionID)
      : taskModel

    await Plugin.trigger(
      "command.execute.before",
      {
        command: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
      },
      { parts },
    )

    const result = (await prompt({
      sessionID: input.sessionID,
      messageID: input.messageID,
      model: userModel,
      agent: userAgent,
      parts,
      variant: input.variant,
    })) as MessageV2.WithParts

    Bus.publish(Command.Event.Executed, {
      name: input.command,
      sessionID: input.sessionID,
      arguments: input.arguments,
      messageID: result.info.id,
    })

    return result
  }

  // The tail carries where the conversation ended up; a title built from the
  // opening prompt alone goes stale as soon as the session moves on.
  const TITLE_CONTEXT_CHARS = 1000

  // The opening prompt names the session, the third renames it once a topic has
  // established itself. A later prompt describes a session the user already
  // recognises, so generation stops.
  const TITLE_ORDINALS = [1, 3]

  // Longer than this is not a 3-7 word title but a model ignoring the prompt,
  // and truncating it produces a worse label than the one already shown.
  const TITLE_MAX_CHARS = 80

  const TITLE_TIMEOUT = 15_000

  // Cut a placeholder at a word boundary rather than mid-word, and leave the
  // ellipsis off — this is a label in a list, not prose.
  const PLACEHOLDER_MAX_CHARS = 50

  // The prompt asks for {"title": "..."} and nothing on the wire enforces it:
  // the SDK constrains output through a forced tool call on Anthropic, which
  // this deliberately tool-less call cannot take. So the parse is the whole
  // enforcement, and it is strict on purpose. Prose that is not the requested
  // object is a model that ignored the instruction, and taking its first line
  // anyway is what produced titles like a bare ``` fence: returning undefined
  // keeps the existing title and lets the next ordinal try again.
  export function parseTitle(text: string) {
    const stripped = text.replace(/<think>[\s\S]*?<\/think>\s*/g, "")
    const json = stripped.match(/\{[\s\S]*\}/)
    if (!json) return
    const parsed = iife(() => {
      try {
        return JSON.parse(json[0]) as { title?: unknown }
      } catch {
        return undefined
      }
    })
    if (typeof parsed?.title !== "string") return
    const title = parsed.title.trim()
    if (!title || title.length > TITLE_MAX_CHARS) return
    return title
  }

  // Only the user's own prompts. An assistant's reply is mostly code and tool
  // output, so a raw conversation tail late in a session is a keyhole onto
  // whatever was being printed when the window closed rather than onto what the
  // session is about. Subtask prompts count as text because a command
  // invocation (/fix, /review) carries the request there and contributes no
  // text part at all.
  export function titleInput(history: MessageV2.WithParts[]) {
    const text = history
      .filter((msg) => msg.info.role === "user" && !msg.info.synthetic)
      .flatMap((msg) =>
        msg.parts.flatMap((part) => {
          if (part.type === "subtask") return [part.prompt]
          if (part.type !== "text" || part.synthetic || part.ignored) return []
          return [part.text]
        }),
      )
      .join("\n")
      .trim()
    return text.length > TITLE_CONTEXT_CHARS ? text.slice(-TITLE_CONTEXT_CHARS) : text
  }

  // Shown the instant the first prompt lands, so the list reads as something
  // recognisable instead of an ISO timestamp for as long as the model takes.
  // Deliberately dumb: the first line of what was asked, which beats a rushed
  // generated title often enough to be worth showing.
  export function derivePlaceholder(text: string) {
    const line = text
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0 && !entry.startsWith("<") && !entry.startsWith("#"))
    if (!line) return
    if (line.length <= PLACEHOLDER_MAX_CHARS) return line
    const cut = line.slice(0, PLACEHOLDER_MAX_CHARS)
    const boundary = cut.lastIndexOf(" ")
    return boundary > 0 ? cut.slice(0, boundary) : cut
  }

  async function placeholderTitle(sessionID: string, parts: MessageV2.Part[]) {
    const text = parts
      .flatMap((part) => {
        if (part.type === "subtask") return [part.prompt]
        if (part.type !== "text" || part.synthetic || part.ignored) return []
        return [part.text]
      })
      .join("\n")
    const placeholder = derivePlaceholder(text)
    if (!placeholder) return
    await Session.update(
      sessionID,
      (draft) => {
        if (!Session.isDefaultTitle(draft.title)) return
        draft.title = placeholder
        draft.titleGenerated = placeholder
      },
      { touch: false },
    )
  }

  // The generator may replace only its own text. Equality proves the title on
  // screen is what it last wrote; anything else means a rename, a fork, a
  // --title, or a subtask description owns the name. A session with no record
  // at all is owned unless its title is still the default, which is what leaves
  // every session written before this existed alone.
  export function generatorOwns(session: Session.Info) {
    if (session.titleGenerated !== undefined) return session.titleGenerated === session.title
    return Session.isDefaultTitle(session.title)
  }

  // The ordinal to generate at, or undefined to leave the title as it is.
  export function titleTrigger(session: Session.Info, history: MessageV2.WithParts[]) {
    if (session.parentID) return
    if (!generatorOwns(session)) return
    const latest = history.findLast((msg) => msg.info.role === "user" && !msg.info.synthetic)
    if (!latest) return
    // The message's own ordinal, not a count of what this turn can see: a
    // re-entered loop (a task result arriving, the compaction route) reaches
    // here with no new prompt, and the ordinal it reads is one already
    // generated at.
    const ordinal = (latest.info as MessageV2.User).ordinal
    if (!ordinal || !TITLE_ORDINALS.includes(ordinal)) return
    if (session.titleOrdinal !== undefined && session.titleOrdinal >= ordinal) return
    return ordinal
  }

  async function ensureTitle(input: {
    session: Session.Info
    history: MessageV2.WithParts[]
    providerID: string
    modelID: string
  }) {
    const ordinal = titleTrigger(input.session, input.history)
    if (!ordinal) return
    const latestUser = input.history.findLast((msg) => msg.info.role === "user" && !msg.info.synthetic)!

    const content = titleInput(input.history)
    if (!content) return

    const agent = await Agent.get("title")
    if (!agent) return
    const model = await iife(async () => {
      if (agent.model) return await Provider.getModel(agent.model.providerID, agent.model.modelID)
      return (
        (await Provider.getSmallModel(input.providerID)) ?? (await Provider.getModel(input.providerID, input.modelID))
      )
    })
    // Claiming the ordinal before the request, not after it, is what stops two
    // turns racing into the same generation. The generation is worth nothing
    // late, so it is bounded rather than left to a retry that could land after
    // the user has renamed the session.
    await Session.update(input.session.id, (draft) => void (draft.titleOrdinal = ordinal), { touch: false })
    const { stream } = await LLM.stream({
      agent,
      user: latestUser.info as MessageV2.User,
      system: { env: [], globalInstructions: [], projectInstructions: [] },
      small: true,
      tools: {},
      model,
      abort: AbortSignal.timeout(TITLE_TIMEOUT),
      sessionID: input.session.id,
      retries: 2,
      messages: [
        {
          role: "user",
          content,
        },
      ],
    })
    const text = await stream.text.catch((err) => log.error("failed to generate title", { error: err }))
    if (!text) return
    const title = parseTitle(text)
    if (!title) return
    return Session.update(
      input.session.id,
      (draft) => {
        // Re-checked against the draft because the request took time: a rename
        // during it owns the title, and a later ordinal's result landing first
        // is the better one.
        if (!generatorOwns(draft)) return
        if (draft.titleOrdinal !== undefined && draft.titleOrdinal > ordinal) return
        draft.title = title
        draft.titleGenerated = title
      },
      { touch: false },
    )
  }
}
