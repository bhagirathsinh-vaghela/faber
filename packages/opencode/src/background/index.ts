import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { Identifier } from "@/id/id"
import { Log } from "@/util/log"
import { Config } from "@/config/config"

export namespace BackgroundTask {
  const log = Log.create({ service: "background-task" })

  export const TaskType = z.enum(["subagent", "shell"])
  export type TaskType = z.infer<typeof TaskType>

  export const Status = z.enum(["running", "completed", "failed", "cancelled"])
  export type Status = z.infer<typeof Status>

  export const Progress = z.object({
    toolCount: z.number(),
    tokens: z.object({ input: z.number(), output: z.number() }),
    currentActivity: z.string().optional(),
    lastUpdate: z.number(),
  })
  export type Progress = z.infer<typeof Progress>

  export const Result = z.object({
    output: z.string(),
    error: z.string().optional(),
    exitCode: z.number().optional(),
  })
  export type Result = z.infer<typeof Result>

  export const SubagentInfo = z.object({
    sessionID: z.string(),
    agent: z.string(),
    prompt: z.string(),
    model: z.object({
      providerID: z.string(),
      modelID: z.string(),
    }),
  })
  export type SubagentInfo = z.infer<typeof SubagentInfo>

  export const ShellInfo = z.object({
    command: z.string(),
    workdir: z.string().optional(),
    timeout: z.number().optional(),
  })
  export type ShellInfo = z.infer<typeof ShellInfo>

  export const Info = z
    .object({
      id: z.string(),
      parentSessionID: z.string(),
      type: TaskType,
      status: Status,
      description: z.string(),
      time: z.object({
        created: z.number(),
        completed: z.number().optional(),
      }),
      progress: Progress.optional(),
      subagent: SubagentInfo.optional(),
      shell: ShellInfo.optional(),
      result: Result.optional(),
    })
    .meta({ ref: "BackgroundTask" })
  export type Info = z.infer<typeof Info>

  export const PendingResult = z.object({
    taskId: z.string(),
    parentSessionID: z.string(),
    type: TaskType,
    description: z.string(),
    agent: z.string().optional(),
    output: z.string(),
    error: z.string().optional(),
    completedAt: z.number(),
    duration: z.number(),
  })
  export type PendingResult = z.infer<typeof PendingResult>

  export const Event = {
    Created: BusEvent.define(
      "background.task.created",
      z.object({
        task: Info,
      }),
    ),
    Progress: BusEvent.define(
      "background.task.progress",
      z.object({
        taskId: z.string(),
        parentSessionID: z.string(),
        progress: Progress,
      }),
    ),
    Completed: BusEvent.define(
      "background.task.completed",
      z.object({
        taskId: z.string(),
        parentSessionID: z.string(),
        status: z.enum(["completed", "failed", "cancelled"]),
        result: Result.optional(),
      }),
    ),
    ResultPending: BusEvent.define(
      "background.task.result_pending",
      z.object({
        sessionID: z.string(),
        pending: PendingResult,
      }),
    ),
    AutoInjectChanged: BusEvent.define(
      "background.task.auto_inject_changed",
      z.object({
        sessionID: z.string(),
        autoInject: z.boolean(),
      }),
    ),
  }

  interface TaskEntry {
    info: Info
    abort?: AbortController
  }

  interface State {
    tasks: Map<string, TaskEntry>
    autoInject: Map<string, boolean> // sessionID -> autoInject toggle
    autoInjectDefault: boolean | null // null = not yet initialized from config
    pending: Map<string, PendingResult[]> // sessionID -> pending results
  }

  const state = Instance.state(
    (): State => ({
      tasks: new Map(),
      autoInject: new Map(),
      autoInjectDefault: null,
      pending: new Map(),
    }),
  )

  async function getConfigDefault(): Promise<boolean> {
    const cfg = await Config.get()
    return cfg.background?.auto_inject ?? false
  }

  export function list(parentSessionID?: string): Info[] {
    const all = Array.from(state().tasks.values()).map((e) => e.info)
    if (parentSessionID) return all.filter((t) => t.parentSessionID === parentSessionID)
    return all
  }

  export function get(taskId: string): Info | undefined {
    return state().tasks.get(taskId)?.info
  }

  export interface CreateInput {
    parentSessionID: string
    type: TaskType
    description: string
    subagent?: SubagentInfo
    shell?: ShellInfo
  }

  export function create(input: CreateInput): { task: Info; abort: AbortController } {
    const abort = new AbortController()
    const task: Info = {
      id: Identifier.ascending("part"),
      parentSessionID: input.parentSessionID,
      type: input.type,
      status: "running",
      description: input.description,
      time: { created: Date.now() },
      subagent: input.subagent,
      shell: input.shell,
    }

    state().tasks.set(task.id, { info: task, abort })
    Bus.publish(Event.Created, { task })
    log.info("created background task", { taskId: task.id, type: task.type, description: task.description })

    return { task, abort }
  }

  export function updateProgress(taskId: string, progress: Progress): void {
    const entry = state().tasks.get(taskId)
    if (!entry || entry.info.status !== "running") return

    entry.info.progress = progress
    Bus.publish(Event.Progress, {
      taskId,
      parentSessionID: entry.info.parentSessionID,
      progress,
    })
  }

  export function complete(taskId: string, status: "completed" | "failed", result?: Result): void {
    const entry = state().tasks.get(taskId)
    if (!entry) return

    // Don't overwrite cancelled status — user explicitly cancelled this task
    if (entry.info.status === "cancelled") return

    entry.info.status = status
    entry.info.result = result
    entry.info.time.completed = Date.now()

    Bus.publish(Event.Completed, {
      taskId,
      parentSessionID: entry.info.parentSessionID,
      status,
      result,
    })
    log.info("background task completed", { taskId, status })
  }

  export function cancel(taskId: string): boolean {
    const entry = state().tasks.get(taskId)
    if (!entry || entry.info.status !== "running") return false

    entry.abort?.abort()
    entry.info.status = "cancelled"
    entry.info.time.completed = Date.now()

    Bus.publish(Event.Completed, {
      taskId,
      parentSessionID: entry.info.parentSessionID,
      status: "cancelled",
      result: { output: "Task cancelled by user" },
    })
    log.info("background task cancelled", { taskId })
    return true
  }

  export function cleanup(taskId: string): void {
    state().tasks.delete(taskId)
  }

  export function running(parentSessionID?: string): Info[] {
    return list(parentSessionID).filter((t) => t.status === "running")
  }

  // Auto-inject management
  export async function getAutoInject(sessionID: string): Promise<boolean> {
    const sessionValue = state().autoInject.get(sessionID)
    if (sessionValue !== undefined) return sessionValue
    return getAutoInjectDefault()
  }

  export function setAutoInject(sessionID: string, value: boolean): void {
    state().autoInject.set(sessionID, value)
    Bus.publish(Event.AutoInjectChanged, { sessionID, autoInject: value })
    log.info("auto-inject changed", { sessionID, autoInject: value })
  }

  export async function toggleAutoInject(sessionID: string): Promise<boolean> {
    const current = await getAutoInject(sessionID)
    setAutoInject(sessionID, !current)
    return !current
  }

  // Global default management
  export async function getAutoInjectDefault(): Promise<boolean> {
    const s = state()
    if (s.autoInjectDefault === null) {
      s.autoInjectDefault = await getConfigDefault()
    }
    return s.autoInjectDefault
  }

  export function setAutoInjectDefault(value: boolean): void {
    state().autoInjectDefault = value
    log.info("auto-inject default changed", { autoInject: value })
  }

  export async function toggleAutoInjectDefault(): Promise<boolean> {
    const current = await getAutoInjectDefault()
    state().autoInjectDefault = !current
    log.info("auto-inject default toggled", { autoInject: !current })
    return !current
  }

  // Pending results management
  export function addPending(sessionID: string, pending: PendingResult): void {
    const list = state().pending.get(sessionID) ?? []
    list.push(pending)
    state().pending.set(sessionID, list)
    Bus.publish(Event.ResultPending, { sessionID, pending })
    log.info("pending result queued", { sessionID, taskId: pending.taskId })
  }

  export function getPending(sessionID: string): PendingResult[] {
    return state().pending.get(sessionID) ?? []
  }

  export function pendingCount(sessionID: string): number {
    return getPending(sessionID).length
  }

  export function clearPending(sessionID: string, taskIds?: string[]): PendingResult[] {
    const current = getPending(sessionID)
    if (!taskIds) {
      state().pending.delete(sessionID)
      log.info("cleared all pending results", { sessionID, count: current.length })
      return current
    }
    const removed = current.filter((p) => taskIds.includes(p.taskId))
    const remaining = current.filter((p) => !taskIds.includes(p.taskId))
    if (remaining.length === 0) state().pending.delete(sessionID)
    else state().pending.set(sessionID, remaining)
    log.info("cleared pending results", { sessionID, removed: removed.length })
    return removed
  }

  export function popPending(sessionID: string, taskId: string): PendingResult | undefined {
    const list = getPending(sessionID)
    const idx = list.findIndex((p) => p.taskId === taskId)
    if (idx === -1) return undefined
    const [removed] = list.splice(idx, 1)
    if (list.length === 0) state().pending.delete(sessionID)
    else state().pending.set(sessionID, list)
    return removed
  }
}
