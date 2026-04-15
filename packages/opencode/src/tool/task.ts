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
import { Config } from "../config/config"
import { PermissionNext } from "@/permission/next"
import { BackgroundTask } from "@/background"
import { Log } from "@/util/log"

const log = Log.create({ service: "task-tool" })

interface BackgroundSubagentInput {
  task: BackgroundTask.Info
  abort: AbortController
  session: Session.Info
  agent: Agent.Info
  model: { modelID: string; providerID: string }
  config: Config.Info
  promptParts: Awaited<ReturnType<typeof SessionPrompt.resolvePromptParts>>
  hasTaskPermission: boolean
}

async function runSubagentInBackground(input: BackgroundSubagentInput) {
  const { task, abort, session, agent, model, config, promptParts, hasTaskPermission } = input

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
      tools: {
        todowrite: false,
        todoread: false,
        ...(hasTaskPermission ? {} : { task: false }),
        ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((t) => [t, false])),
      },
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

    await injectCompletionResult(task, text)
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

    await injectCompletionResult(task, "", errorMsg)
  }
}

async function injectCompletionResult(task: BackgroundTask.Info, output: string, error?: string) {
  const duration = (task.time.completed ?? Date.now()) - task.time.created
  const autoInject = await BackgroundTask.getAutoInject(task.parentSessionID)

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

  // Get existing messages to calculate next promptIndex and resolve parent session's agent/model
  const existingMessages = await Session.messages({ sessionID: task.parentSessionID })
  const maxPromptIndex = existingMessages.reduce((max, m) => Math.max(max, m.info.promptIndex ?? 0), 0)

  // Use the parent session's agent/model so the triggered LLM loop doesn't switch agents
  // (which would change the system prompt and break the cache prefix)
  const lastRealUser = existingMessages.findLast((m) => m.info.role === "user" && !m.info.synthetic)
  const parentUser = lastRealUser?.info as MessageV2.User | undefined
  const model = parentUser?.model ?? { providerID: "unknown", modelID: "unknown" }
  const agent = parentUser?.agent ?? "build"
  const variant = parentUser?.variant

  const messageID = Identifier.ascending("message")
  const userMsg: MessageV2.User = {
    id: messageID,
    sessionID: task.parentSessionID,
    role: "user",
    time: { created: Date.now() },
    agent,
    model,
    variant,
    synthetic: true,
    promptIndex: maxPromptIndex + 1,
  }
  await Session.updateMessage(userMsg)

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
  const maxPromptIndex = existingMessages.reduce((max, m) => Math.max(max, m.info.promptIndex ?? 0), 0)
  const lastRealUser = existingMessages.findLast((m) => m.info.role === "user" && !m.info.synthetic)
  const parentUser = lastRealUser?.info as MessageV2.User | undefined
  const model = parentUser?.model ?? { providerID: "unknown", modelID: "unknown" }
  const agent = parentUser?.agent ?? "build"
  const variant = parentUser?.variant

  const messageID = Identifier.ascending("message")
  const userMsg: MessageV2.User = {
    id: messageID,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent,
    model,
    variant,
    synthetic: true,
    promptIndex: maxPromptIndex + 1,
  }
  await Session.updateMessage(userMsg)

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

function buildMinimalTask(p: BackgroundTask.PendingResult): BackgroundTask.Info {
  return {
    id: p.taskId,
    parentSessionID: p.parentSessionID,
    type: p.type,
    status: p.error ? "failed" : "completed",
    description: p.description,
    time: { created: p.completedAt - p.duration, completed: p.completedAt },
    subagent: p.agent
      ? { sessionID: "", agent: p.agent, prompt: "", model: { providerID: "unknown", modelID: "unknown" } }
      : undefined,
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
    task.type === "subagent" ? `agent: ${task.subagent?.agent}` : `command: ${task.shell?.command}`,
    `session_id: ${task.subagent?.sessionID ?? ""}`,
    ``,
    body,
    `</background-task-result>`,
  ].join("\n")
}

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  session_id: z.string().describe("Existing Task session to continue").optional(),
  command: z.string().describe("The command that triggered this task").optional(),
}).strict()

export const TaskTool = Tool.define("task", async (ctx) => {
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))

  // Filter agents by permissions if agent provided
  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => PermissionNext.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents

  const description = DESCRIPTION.replace(
    "{agents}",
    accessibleAgents
      .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
      .join("\n"),
  )
  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const config = await Config.get()

      // Skip permission check when user explicitly invoked via @ or command subtask
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

      const agent = await Agent.get(params.subagent_type)
      if (!agent) throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)

      const hasTaskPermission = agent.permission.some((rule) => rule.permission === "task")

      const session = await iife(async () => {
        if (params.session_id) {
          const found = await Session.get(params.session_id).catch(() => {})
          if (found) return found
        }

        return await Session.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${agent.name} subagent)`,
          permission: [
            {
              permission: "todowrite",
              pattern: "*",
              action: "deny",
            },
            {
              permission: "todoread",
              pattern: "*",
              action: "deny",
            },
            ...(hasTaskPermission
              ? []
              : [
                  {
                    permission: "task" as const,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(config.experimental?.primary_tools?.map((t) => ({
              pattern: "*",
              action: "allow" as const,
              permission: t,
            })) ?? []),
          ],
        })
      })
      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

      const model = agent.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

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
        config,
        promptParts,
        hasTaskPermission,
      })

      return {
        title: params.description,
        metadata: {
          status: "async_launched",
          taskId: task.id,
          sessionId: session.id,
          model,
          summary: [],
        } as Record<string, unknown>,
        output: [
          `Background task started: ${params.description}`,
          `agent: ${agent.name}`,
          `<task_metadata>`,
          `task_id: ${task.id}`,
          `session_id: ${session.id}`,
          `STATUS: DELEGATED — THIS IS ONLY A LAUNCH CONFIRMATION, NOT THE RESULT`,
          `The task "${params.description}" is now running in a background ${agent.name} session.`,
          `The actual result has NOT arrived yet. It will arrive later as a <background-task-result> message with this task_id.`,
          `Until <background-task-result task_id="${task.id}"> appears, you have ZERO information about this task's outcome.`,
          `Do NOT read files, search code, run commands, or do any work related to "${params.description}".`,
          `</task_metadata>`,
        ].join("\n"),
      }
    },
  }
})
