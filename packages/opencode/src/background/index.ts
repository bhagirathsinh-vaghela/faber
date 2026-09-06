import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { Identifier } from "@/id/id"
import { Log } from "@/util/log"
import { Config } from "@/config/config"

export namespace BackgroundSubagent {
  const log = Log.create({ service: "background-subagent" })

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

  export const Info = z
    .object({
      id: z.string(),
      parentSessionID: z.string(),
      status: Status,
      description: z.string(),
      time: z.object({
        created: z.number(),
        completed: z.number().optional(),
      }),
      progress: Progress.optional(),
      subagent: SubagentInfo.optional(),
      result: Result.optional(),
    })
    .meta({ ref: "BackgroundSubagent" })
  export type Info = z.infer<typeof Info>

  export const PendingResult = z.object({
    subagentId: z.string(),
    parentSessionID: z.string(),
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
      "background.subagent.created",
      z.object({
        subagent: Info,
      }),
    ),
    Progress: BusEvent.define(
      "background.subagent.progress",
      z.object({
        subagentId: z.string(),
        parentSessionID: z.string(),
        progress: Progress,
      }),
    ),
    Completed: BusEvent.define(
      "background.subagent.completed",
      z.object({
        subagentId: z.string(),
        parentSessionID: z.string(),
        status: z.enum(["completed", "failed", "cancelled"]),
        result: Result.optional(),
      }),
    ),
    ResultPending: BusEvent.define(
      "background.subagent.result_pending",
      z.object({
        sessionID: z.string(),
        pending: PendingResult,
      }),
    ),
    AutoInjectChanged: BusEvent.define(
      "background.subagent.auto_inject_changed",
      z.object({
        sessionID: z.string(),
        autoInject: z.boolean(),
      }),
    ),
  }

  interface Entry {
    info: Info
    abort?: AbortController
  }

  interface State {
    subagents: Map<string, Entry>
    autoInject: Map<string, boolean> // sessionID -> autoInject toggle
    autoInjectDefault: boolean | null // null = not yet initialized from config
    pending: Map<string, PendingResult[]> // sessionID -> pending results
  }

  const state = Instance.state(
    (): State => ({
      subagents: new Map(),
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
    const all = Array.from(state().subagents.values()).map((e) => e.info)
    if (parentSessionID) return all.filter((t) => t.parentSessionID === parentSessionID)
    return all
  }

  export function get(subagentId: string): Info | undefined {
    return state().subagents.get(subagentId)?.info
  }

  export interface CreateInput {
    parentSessionID: string
    description: string
    subagent?: SubagentInfo
  }

  export function create(input: CreateInput): { subagent: Info; abort: AbortController } {
    const abort = new AbortController()
    const subagent: Info = {
      id: Identifier.ascending("part"),
      parentSessionID: input.parentSessionID,
      status: "running",
      description: input.description,
      time: { created: Date.now() },
      subagent: input.subagent,
    }

    state().subagents.set(subagent.id, { info: subagent, abort })
    Bus.publish(Event.Created, { subagent })
    log.info("created background subagent", { subagentId: subagent.id, description: subagent.description })

    return { subagent, abort }
  }

  export function updateProgress(subagentId: string, progress: Progress): void {
    const entry = state().subagents.get(subagentId)
    if (!entry || entry.info.status !== "running") return

    entry.info.progress = progress
    Bus.publish(Event.Progress, {
      subagentId,
      parentSessionID: entry.info.parentSessionID,
      progress,
    })
  }

  export function complete(subagentId: string, status: "completed" | "failed", result?: Result): void {
    const entry = state().subagents.get(subagentId)
    if (!entry) return

    // Don't overwrite cancelled status — user explicitly cancelled this subagent
    if (entry.info.status === "cancelled") return

    entry.info.status = status
    entry.info.result = result
    entry.info.time.completed = Date.now()

    Bus.publish(Event.Completed, {
      subagentId,
      parentSessionID: entry.info.parentSessionID,
      status,
      result,
    })
    log.info("background subagent completed", { subagentId, status })
  }

  export function cancel(subagentId: string): boolean {
    const entry = state().subagents.get(subagentId)
    if (!entry || entry.info.status !== "running") return false

    entry.abort?.abort()
    entry.info.status = "cancelled"
    entry.info.time.completed = Date.now()

    Bus.publish(Event.Completed, {
      subagentId,
      parentSessionID: entry.info.parentSessionID,
      status: "cancelled",
      result: { output: "Subagent cancelled by user" },
    })
    log.info("background subagent cancelled", { subagentId })
    return true
  }

  export function cleanup(subagentId: string): void {
    state().subagents.delete(subagentId)
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
    log.info("pending result queued", { sessionID, subagentId: pending.subagentId })
  }

  export function getPending(sessionID: string): PendingResult[] {
    return state().pending.get(sessionID) ?? []
  }

  export function pendingCount(sessionID: string): number {
    return getPending(sessionID).length
  }

  export function clearPending(sessionID: string, subagentIds?: string[]): PendingResult[] {
    const current = getPending(sessionID)
    if (!subagentIds) {
      state().pending.delete(sessionID)
      log.info("cleared all pending results", { sessionID, count: current.length })
      return current
    }
    const removed = current.filter((p) => subagentIds.includes(p.subagentId))
    const remaining = current.filter((p) => !subagentIds.includes(p.subagentId))
    if (remaining.length === 0) state().pending.delete(sessionID)
    else state().pending.set(sessionID, remaining)
    log.info("cleared pending results", { sessionID, removed: removed.length })
    return removed
  }

  export function popPending(sessionID: string, subagentId: string): PendingResult | undefined {
    const list = getPending(sessionID)
    const idx = list.findIndex((p) => p.subagentId === subagentId)
    if (idx === -1) return undefined
    const [removed] = list.splice(idx, 1)
    if (list.length === 0) state().pending.delete(sessionID)
    else state().pending.set(sessionID, list)
    return removed
  }
}
