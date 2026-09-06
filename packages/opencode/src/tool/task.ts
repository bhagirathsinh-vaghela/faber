import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { Bus } from "../bus"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { SessionPrompt } from "../session/prompt"
import { SessionRevert } from "../session/revert"
import { iife } from "@/util/iife"
import { PermissionNext } from "@/permission/next"
import { BackgroundTask } from "@/background"
import { BackgroundNotify } from "@/background/notify"
import { Config } from "@/config/config"
import { Log } from "@/util/log"

const log = Log.create({ service: "task-tool" })

interface BackgroundSubagentInput {
  task: BackgroundTask.Info
  abort: AbortController
  session: Session.Info
  agent: Agent.Info
  model: { modelID: string; providerID: string }
  promptParts: Awaited<ReturnType<typeof SessionPrompt.resolvePromptParts>>
  // A resumed subagent MUST inject its result even when the parent's auto-inject
  // resolves off: the restart wiped the per-session setting, and the parent was
  // told to WAIT for this injection rather than re-launch, so queueing it as a
  // pending result would strand it behind a parent that never asks.
  forceInject?: boolean
}

async function runSubagentInBackground(input: BackgroundSubagentInput) {
  const { task, abort, session, agent, model, promptParts } = input

  let toolCount = 0
  const messageID = Identifier.ascending("message")

  const progressUnsub = Bus.subscribe(MessageV2.Event.PartUpdated, (evt) => {
    if (evt.properties.part.sessionID !== session.id) return
    if (evt.properties.part.type !== "tool") return

    const part = evt.properties.part
    if (part.state.status === "completed") toolCount++

    BackgroundTask.updateProgress(task.id, {
      toolCount,
      tokens: { input: 0, output: 0 },
      currentActivity: part.state.status === "running" ? `Running ${part.tool}...` : `Completed ${part.tool}`,
      lastUpdate: Date.now(),
    })
  })

  function handleCancel() {
    SessionPrompt.cancel(session.id)
  }
  abort.signal.addEventListener("abort", handleCancel)

  try {
    const result = await SessionPrompt.prompt({
      messageID,
      sessionID: session.id,
      model,
      agent: agent.name,
      tools: {},
      parts: promptParts,
    })

    progressUnsub()
    abort.signal.removeEventListener("abort", handleCancel)

    // If cancelled by user while prompt was completing, inject cancellation instead
    const currentAfterComplete = BackgroundTask.get(task.id)
    if (currentAfterComplete?.status === "cancelled") {
      log.info("background subagent cancelled by user (completed race)", { taskId: task.id })
      const duration = (task.time.completed ?? Date.now()) - task.time.created
      await doInject(task, "", undefined, duration, true, "cancelled")
      return
    }

    const text = result.parts.findLast((x) => x.type === "text")?.text ?? ""

    BackgroundTask.complete(task.id, "completed", { output: text })

    await injectCompletionResult(task, text, undefined, input.forceInject)
  } catch (error) {
    progressUnsub()
    abort.signal.removeEventListener("abort", handleCancel)

    // If already cancelled (by user via TUI), inject directly bypassing auto-inject check
    const current = BackgroundTask.get(task.id)
    if (current?.status === "cancelled") {
      log.info("background subagent cancelled by user", { taskId: task.id })
      const duration = (task.time.completed ?? Date.now()) - task.time.created
      await doInject(task, "", undefined, duration, true, "cancelled")
      return
    }

    const errorMsg = error instanceof Error ? error.message : String(error)
    log.error("background subagent failed", { taskId: task.id, error: errorMsg })

    BackgroundTask.complete(task.id, "failed", { output: "", error: errorMsg })

    await injectCompletionResult(task, "", errorMsg, input.forceInject)
  }
}

async function injectCompletionResult(task: BackgroundTask.Info, output: string, error?: string, force?: boolean) {
  const duration = (task.time.completed ?? Date.now()) - task.time.created
  const autoInject = force || (await BackgroundTask.getAutoInject(task.parentSessionID))

  // If autoInject is disabled, queue the result instead
  if (!autoInject) {
    BackgroundTask.addPending(task.parentSessionID, {
      taskId: task.id,
      parentSessionID: task.parentSessionID,
      type: task.type,
      description: task.description,
      agent: task.subagent?.agent,
      output,
      error,
      completedAt: Date.now(),
      duration,
    })
    log.info("queued background task result (autoInject disabled)", {
      taskId: task.id,
      parentSessionID: task.parentSessionID,
    })
    return
  }

  // Auto-inject is enabled, inject directly
  await doInject(task, output, error, duration)
}

async function doInject(
  task: BackgroundTask.Info,
  output: string,
  error: string | undefined,
  duration: number,
  autoTriggerLLM = true,
  statusOverride?: "cancelled",
) {
  const session = await Session.get(task.parentSessionID)
  if (session.revert) {
    await SessionRevert.cleanup(session)
  }

  const status: "completed" | "failed" | "cancelled" = statusOverride ?? (error ? "failed" : "completed")
  const notification = buildNotification(task, output, error, duration, status)

  const existingMessages = await Session.messages({ sessionID: task.parentSessionID })
  const messageID = await MessageV2.mintSyntheticMessage(task.parentSessionID, existingMessages)

  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID,
    sessionID: task.parentSessionID,
    type: "text",
    text: notification,
    synthetic: true,
    backgroundTaskResult: {
      taskId: task.id,
      type: task.type,
      description: task.description,
      status,
      agent: task.subagent?.agent,
      duration,
    },
  })

  log.info("injected background task result", { taskId: task.id, parentSessionID: task.parentSessionID })

  // Trigger LLM to respond to the task result (only for auto-inject)
  // The TASK RESULT user message we just created will be used by the loop
  if (autoTriggerLLM) {
    SessionPrompt.loop(task.parentSessionID).catch((err) => {
      log.error("failed to prompt after task result injection", { taskId: task.id, error: err })
    })
  }
}

// Export for accepting pending results from TUI
export async function acceptPendingResult(sessionID: string, taskId: string, triggerLLM = false): Promise<boolean> {
  log.info("acceptPendingResult called", { sessionID, taskId, triggerLLM })
  const pending = BackgroundTask.popPending(sessionID, taskId)
  if (!pending) {
    log.warn("acceptPendingResult: no pending result found", { sessionID, taskId })
    return false
  }

  log.info("acceptPendingResult: found pending", { taskId, description: pending.description })

  const task = BackgroundTask.get(taskId) ?? buildMinimalTask(pending)
  await doInject(task, pending.output, pending.error, pending.duration, triggerLLM)
  log.info("acceptPendingResult: injection complete", { taskId })
  return true
}

export async function acceptAllPending(sessionID: string, triggerLLM = false): Promise<number> {
  const pending = BackgroundTask.clearPending(sessionID)
  if (pending.length === 0) return 0

  if (pending.length === 1) {
    const p = pending[0]
    const task = BackgroundTask.get(p.taskId) ?? buildMinimalTask(p)
    await doInject(task, p.output, p.error, p.duration, triggerLLM)
    return 1
  }

  const session = await Session.get(sessionID)
  if (session.revert) {
    await SessionRevert.cleanup(session)
  }

  const existingMessages = await Session.messages({ sessionID })

  const messageID = await MessageV2.mintSyntheticMessage(sessionID, existingMessages)

  for (const p of pending) {
    const task = BackgroundTask.get(p.taskId) ?? buildMinimalTask(p)
    const status: "completed" | "failed" = p.error ? "failed" : "completed"
    const notification = buildNotification(task, p.output, p.error, p.duration)
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID,
      sessionID,
      type: "text",
      text: notification,
      synthetic: true,
      backgroundTaskResult: {
        taskId: task.id,
        type: task.type,
        description: task.description,
        status,
        agent: task.subagent?.agent,
        duration: p.duration,
      },
    })
    log.info("injected background task result into merged message", { taskId: task.id, sessionID })
  }

  if (triggerLLM) {
    SessionPrompt.loop(sessionID).catch((err) => {
      log.error("failed to prompt after merged task result injection", { error: err })
    })
  }

  return pending.length
}

// Resume the subagents a restart cut off under a parent that is itself being
// resumed. The parent and its in-flight subagent come back as a UNIT, so the
// parent's continue prompt can promise the subagent is alive and the parent then
// waits for the injection rather than re-launching the work.
//
// The BackgroundTask record that linked a subagent to its parent lived in memory
// and died with the restart, so this rebuilds it from the child session's
// persisted state: the parent is the caller, the description is the child's
// title, and the agent/model come off the child's own last real user message
// (the same inheritance a fresh subagent resolves). The child is then re-driven
// through the ordinary subagent wrapper with a continue prompt, so completing
// injects into the parent exactly as an uninterrupted subagent would have.
//
// Returns how many subagents were resumed, so the caller can tell the parent.
export async function resumeSubagents(parentSessionID: string): Promise<number> {
  // Dynamic import: ping.ts dynamically imports this module, so a static import
  // back would close the cycle.
  const { SessionPing } = await import("../session/ping")
  const children = await Session.children(parentSessionID)
  let resumed = 0
  for (const child of children) {
    if (!(await SessionPing.interrupted(child.id))) continue

    // No resolvable model means the re-drive would throw and deliver a failed
    // result: skip it rather than resume into a guaranteed failure. A task-tool
    // subagent always carries a model on its prompt, so this only guards a
    // malformed child.
    if (!child.current?.model) {
      log.error("cannot resume subagent, no model on record", { child: child.id })
      continue
    }
    const model = child.current.model
    // defaultAgent throws on a misconfigured default; a resume must not abort the
    // whole loop for a config fault, so degrade to the built-in "build".
    const agentName = child.current.agent ?? (await Agent.defaultAgent().catch(() => "build"))
    const agent = await Agent.get(agentName).catch(() => undefined)
    if (!agent) {
      log.error("cannot resume subagent, agent gone", { child: child.id, agent: agentName })
      continue
    }

    const { task, abort } = BackgroundTask.create({
      parentSessionID,
      type: "subagent",
      description: child.title,
      subagent: { sessionID: child.id, agent: agentName, prompt: "", model },
    })

    // A continue prompt, not the original: the child resumes its cut-off turn
    // rather than re-running its instructions from the top. The same wrapper
    // carries the completion into an injection for the parent.
    const promptParts = await SessionPrompt.resolvePromptParts(SUBAGENT_RESUME_TEXT)
    void runSubagentInBackground({ task, abort, session: child, agent, model, promptParts, forceInject: true })
    resumed++
    log.info("resumed interrupted subagent", { child: child.id, parent: parentSessionID })
  }
  return resumed
}

export const SUBAGENT_RESUME_TEXT =
  "Pardon the interruption — the server restarted and your turn was cut off. Continue what you were doing and finish the task you were given; your result is still awaited by the session that launched you."

// The subagents of a session, durable across a restart. The in-memory
// BackgroundTask store is lost on restart, so a dialog reading it alone shows
// nothing that ran before the restart and can double-count a child whose task
// was recreated by a resume. The child SESSIONS are durable (on disk, linked by
// parentID), so this is the source of truth: every subagent child is a subagent,
// keyed by its session id, and an in-memory task for that child (which carries
// live progress and the result) overrides the disk-derived shell when present.
//
// Status comes off the child's last assistant turn: no message yet is pending,
// a turn still open is running, a finished turn is completed. This is a
// projection, so it is rebuilt from disk every call rather than mutated.
export async function subagentsForSession(parentSessionID: string): Promise<BackgroundTask.Info[]> {
  const live = new Map(
    BackgroundTask.list(parentSessionID)
      .filter((t) => t.subagent?.sessionID)
      .map((t) => [t.subagent!.sessionID, t] as const),
  )
  const children = await Session.children(parentSessionID)
  const result: BackgroundTask.Info[] = []
  for (const child of children) {
    const held = live.get(child.id)
    if (held) {
      result.push(held)
      continue
    }
    const messages = await Session.messages({ sessionID: child.id })
    const assistants = messages.filter((m) => m.info.role === "assistant")
    const last = assistants.at(-1)?.info as MessageV2.Assistant | undefined
    const status: BackgroundTask.Status = last === undefined ? "running" : last.time.completed ? "completed" : "running"
    result.push({
      id: child.id,
      parentSessionID,
      type: "subagent",
      status,
      description: child.title,
      time: { created: child.time.created, ...(last?.time.completed ? { completed: last.time.completed } : {}) },
      subagent: {
        sessionID: child.id,
        agent: child.current?.agent ?? MessageV2.UNKNOWN_AGENT,
        prompt: "",
        model: child.current?.model ?? MessageV2.UNKNOWN_MODEL,
      },
    })
  }
  // Newest first, so the most recent subagents head the dialog.
  return result.sort((a, b) => b.time.created - a.time.created)
}

function buildMinimalTask(p: BackgroundTask.PendingResult): BackgroundTask.Info {
  return {
    id: p.taskId,
    parentSessionID: p.parentSessionID,
    type: p.type,
    status: p.error ? "failed" : "completed",
    description: p.description,
    time: { created: p.completedAt - p.duration, completed: p.completedAt },
    subagent: p.agent ? { sessionID: "", agent: p.agent, prompt: "", model: MessageV2.UNKNOWN_MODEL } : undefined,
  }
}

function buildNotification(
  task: BackgroundTask.Info,
  output: string,
  error: string | undefined,
  duration: number,
  statusOverride?: string,
) {
  const status = statusOverride ?? (error ? "failed" : "completed")
  const body =
    status === "cancelled"
      ? "This task was cancelled by the user. Do not retry or continue this task."
      : error
        ? `ERROR: ${error}`
        : output
  return [
    `<background-task-result>`,
    `task_id: ${task.id}`,
    `type: ${task.type}`,
    `status: ${status}`,
    `duration: ${Math.round(duration / 1000)}s`,
    task.type === "subagent"
      ? `agent: ${task.subagent?.agent}`
      : // Collapse blank lines so a multi-line command cannot forge the
        // header/body separator the reader splits on.
        `command: ${BackgroundNotify.collapse(task.shell?.command ?? "")}`,
    `session_id: ${task.subagent?.sessionID ?? ""}`,
    ``,
    body,
    `</background-task-result>`,
  ].join("\n")
}

const parameters = z
  .object({
    description: z.string().describe("A short (3-5 words) description of the task"),
    prompt: z.string().describe("The task for the agent to perform"),
    summary: z
      .string()
      .describe(
        "A one-sentence TL;DR of what the subagent is being asked to do, so the main thread and user can see the ask without reading the full prompt. ALWAYS provide this when invoking the Task tool. MUST faithfully reflect the prompt — do not editorialize or add intent the prompt does not contain.",
      )
      .optional(),
    subagent_type: z.string().describe("The type of specialized agent to use for this task"),
    toolset: z
      .string()
      .describe(
        "The named tool preset the subagent runs with. Must be one of the toolsets listed in this tool's description.",
      ),
    session_id: z.string().describe("Existing Task session to continue").optional(),
    include_context: z
      .boolean()
      .describe(
        "When true, the subagent inherits the parent conversation history for shared context and prompt cache reuse",
      )
      .optional(),
    command: z.string().describe("The command that triggered this task").optional(),
  })
  .strict()

export const TaskTool = Tool.define("task", async (ctx) => {
  const snapshot = ctx?.snapshot
  const agents = (snapshot?.agentList ?? (await Agent.list())).filter((a) => a.mode !== "primary")

  // Filter agents by permissions if agent provided
  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => PermissionNext.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents

  // Repo-scoped agents are listed in a durable message block instead (see
  // TaskAgents.build), keeping this description equal across projects so the
  // tools[] prefix Anthropic hashes first can be shared between them.
  const scoped = await Config.projectAgents()
  const toolsets = snapshot?.toolsets ?? (await Agent.toolsets())
  const description = DESCRIPTION.replace(
    "{agents}",
    accessibleAgents
      .filter((a) => !scoped.has(a.name))
      .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
      .join("\n"),
  ).replace(
    "{toolsets}",
    Object.entries(toolsets)
      .map(([name, tools]) => `- ${name}: ${tools.join(", ")}`)
      .join("\n"),
  )
  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const caller = await Session.get(ctx.sessionID)
      if (caller.parentID) {
        return {
          title: params.description,
          metadata: {} as Record<string, unknown>,
          output:
            "Subagents cannot spawn further subagents. Execute the work directly using your available tools instead.",
        }
      }

      const allowed = toolsets[params.toolset]
      if (!allowed) {
        return {
          title: params.description,
          metadata: {} as Record<string, unknown>,
          output: `Unknown toolset "${params.toolset}". Available toolsets: ${Object.keys(toolsets).join(", ")}.`,
        }
      }

      // Skip permission check when user explicitly invoked via @ or command subagent
      if (!ctx.extra?.bypassAgentCheck) {
        await ctx.ask({
          permission: "task",
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const agent = snapshot?.agents[ctx.agent] ?? (await Agent.get(ctx.agent))
      if (!agent) throw new Error(`Unknown agent type: ${ctx.agent} is not a valid agent type`)

      const session = await iife(async () => {
        if (params.session_id) {
          const found = await Session.get(params.session_id).catch(() => {})
          if (found) return found
        }

        const created = await Session.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${params.subagent_type} subagent)`,
        })
        await Session.update(created.id, (draft) => {
          draft.allowedTools = allowed
        })
        return created
      })
      // Copy parent conversation into child session for shared context + cache reuse
      if (params.include_context && !params.session_id) {
        const parentMessages = await Session.messages({ sessionID: ctx.sessionID })
        const idMap = new Map<string, string>()
        for (const parentMsg of parentMessages) {
          const newID = Identifier.ascending("message")
          idMap.set(parentMsg.info.id, newID)
          const parentID =
            parentMsg.info.role === "assistant" && parentMsg.info.parentID
              ? idMap.get(parentMsg.info.parentID)
              : undefined
          await Session.updateMessage({
            ...parentMsg.info,
            sessionID: session.id,
            id: newID,
            ...(parentID && { parentID }),
          })
          for (const part of parentMsg.parts) {
            await Session.updatePart({
              ...part,
              id: Identifier.ascending("part"),
              messageID: newID,
              sessionID: session.id,
            })
          }
        }
      }

      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

      const model = { modelID: msg.info.modelID, providerID: msg.info.providerID }

      const promptParts = await SessionPrompt.resolvePromptParts(params.prompt)

      const { task, abort } = BackgroundTask.create({
        parentSessionID: ctx.sessionID,
        type: "subagent",
        description: params.description,
        subagent: {
          sessionID: session.id,
          agent: agent.name,
          prompt: params.prompt,
          model,
        },
      })

      // Fire and forget - run in background
      runSubagentInBackground({
        task,
        abort,
        session,
        agent,
        model,
        promptParts,
      })

      return {
        title: params.description,
        metadata: {
          status: "async_launched",
          taskId: task.id,
          sessionId: session.id,
          model,
          toolset: params.toolset,
          tools: allowed,
          summary: params.summary,
        } as Record<string, unknown>,
        output: [
          `Background task started: ${params.description}`,
          `agent: ${agent.name}`,
          `toolset: ${params.toolset} (${allowed.join(", ")})`,
          ...(params.summary ? [`summary: ${params.summary}`] : []),
          `task_id: ${task.id}`,
          `session_id: ${session.id}`,
          ``,
          `<system-reminder>`,
          `This task is now running in a background ${agent.name} session.`,
          `For this specific task ("${params.description}"), you are the`,
          `orchestrator, not the executor. This does not change your role for`,
          `anything else — continue executing other work normally.`,
          ``,
          `For "${params.description}" specifically:`,
          `- Acknowledge the delegation to the user in one sentence`,
          `- The result will be delivered by the system as a new user-turn`,
          `  message. Only the system produces result deliveries for background`,
          `  tasks. Your response contains only your acknowledgment.`,
          `- Continue actively with whatever else the user needs`,
          ``,
          `The background agent has its own tools and full context. Any work`,
          `you do on "${params.description}" or any attempt to anticipate its`,
          `results before they are delivered will produce fabricated output`,
          `that conflicts with the real results.`,
          `</system-reminder>`,
        ].join("\n"),
      }
    },
  }
})
