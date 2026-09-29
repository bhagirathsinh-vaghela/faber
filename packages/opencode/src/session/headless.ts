import z from "zod"
import { Provider } from "@/provider/provider"
import { PermissionNext } from "@/permission/next"
import { Agent } from "@/agent/agent"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { Session } from "."
import { SessionPrompt } from "./prompt"
import { MessageV2 } from "./message-v2"
import { Recovery } from "./recovery"
import { Sessions } from "@/storage/sessions"
import { Storage } from "@/storage/storage"
import { GlobalBus } from "@/bus/global"
import { Event as ServerEvent } from "@/server/event"

// An agent run with no parent and no human: the loop a subagent runs, started
// over HTTP, returning only its final message. Every permission prompt is
// denied and reported. The session is hidden while it runs and removed after.
export namespace HeadlessAgent {
  const log = Log.create({ service: "headless-agent" })

  const DEFAULT_TIMEOUT = 600_000
  export const NET_MS = 5000

  export const Input = z.object({
    agent: z.string().min(1).describe("Agent name, e.g. build or plan"),
    prompt: z.string().min(1),
    system: z.string().optional().describe("Extra instructions, sent ahead of the prompt"),
    model: z.string().describe('provider/model, or "default" for the agent\'s model, then the configured one'),
    variant: z
      .string()
      .describe("A variant the model offers, or \"default\" for the agent's, then the model's configured one"),
    bare: z.boolean().optional().describe("Leave out AGENTS.md, MCP tools, and skills. Defaults to true."),
    timeoutMs: z.number().int().positive().optional(),
    keep: z.boolean().optional().describe("Keep the session after the run, for debugging"),
  })
  export type Input = z.infer<typeof Input>

  export const Result = z.object({
    result: z.string(),
    finish: z.string().optional(),
    num_turns: z.number(),
    usage: z.object({
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cacheRead: z.number(),
      cacheWrite: z.number(),
    }),
    cost: z.number(),
    permission_denials: PermissionNext.Denial.array(),
    model: z.string().optional(),
    session_id: z.string().optional(),
    is_error: z.boolean(),
    errors: z.array(z.string()),
  })
  export type Result = z.infer<typeof Result>

  const EMPTY_USAGE = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }

  function failure(errors: string[]): Result {
    return {
      result: "",
      num_turns: 0,
      usage: EMPTY_USAGE,
      cost: 0,
      permission_denials: [],
      is_error: true,
      errors,
    }
  }

  function describe(error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }

  // A headless run cannot ask the user anything or switch modes on their behalf.
  // It does not delegate either: the run waits on this session's own turns and
  // jobs, and a child subagent is neither.
  const RULES: PermissionNext.Ruleset = [
    { permission: "question", pattern: "*", action: "deny" },
    { permission: "plan_enter", pattern: "*", action: "deny" },
    { permission: "plan_exit", pattern: "*", action: "deny" },
    { permission: "agent", pattern: "*", action: "deny" },
  ]

  export async function run(input: Input): Promise<Result> {
    const agent = await Agent.get(input.agent)
    if (!agent) return failure([`headless: unknown agent "${input.agent}"`])
    const ref =
      input.model === Provider.DEFAULT ? (await SessionPrompt.defaults(agent)).model : Provider.parseModel(input.model)
    const model = await Provider.getModel(ref.providerID, ref.modelID).catch((error) => error as Error)
    if (model instanceof Error) return failure([`headless: model "${input.model}": ${model.message}`])

    const session = await Session.createNext({
      directory: Instance.directory,
      title: `headless ${agent.name}`,
      permission: RULES,
      ephemeral: true,
      bare: input.bare ?? true,
    })
    const denials = await PermissionNext.headless(session.id)

    // The turn can end while a bash job it started is still running; the job's
    // result wakes the session for another turn. The run is over when the
    // session is done by the same rule a subagent's result waits on, checked
    // when it can change: every debt write and every turn edge pushes this
    // session's busy facts, the trigger Recovery itself acts on. The slow net
    // covers a push that failed to emit.
    const deadline = AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT)
    // A bus or timer callback has no instance context, so it re-enters the run's own.
    const directory = Instance.directory
    const settled = () => {
      const over = Promise.withResolvers<void>()
      const check = async () => {
        // A session deleted mid-run never settles; any other failure may pass.
        const done = await Instance.provide({
          directory,
          fn: async () => Recovery.done(await Session.get(session.id)),
        }).catch((error) => {
          if (Storage.NotFoundError.isInstance(error)) over.reject(error)
          return false
        })
        if (done) over.resolve()
      }
      const listener = (event: { payload: { type: string; properties: { sessions?: Record<string, unknown> } } }) => {
        if (event.payload.type === ServerEvent.Busy.type && event.payload.properties.sessions?.[session.id]) void check()
      }
      const expired = () => over.reject(new Error(`timed out after ${input.timeoutMs ?? DEFAULT_TIMEOUT}ms`))
      GlobalBus.on("event", listener)
      const net = setInterval(check, NET_MS)
      deadline.addEventListener("abort", expired)
      if (deadline.aborted) expired()
      // Listening starts after the prompt returned, so its turn-end push may
      // already have passed.
      void check()
      return over.promise.finally(() => {
        GlobalBus.off("event", listener)
        clearInterval(net)
        deadline.removeEventListener("abort", expired)
      })
    }
    const expiry = () =>
      void Instance.provide({ directory, fn: () => Session.stop({ sessionID: session.id }) }).catch((error) =>
        log.error("headless timeout stop failed", { sessionID: session.id, error }),
      )
    deadline.addEventListener("abort", expiry)

    const outcome = await SessionPrompt.prompt({
      sessionID: session.id,
      agent: agent.name,
      model: { providerID: model.providerID, modelID: model.id },
      variant: input.variant,
      parts: [
        ...(input.system ? [{ type: "text" as const, text: input.system }] : []),
        { type: "text" as const, text: input.prompt },
      ],
    })
      .then(settled)
      .then(() => summarize(session.id))
      .catch((error) => failure([`headless: ${agent.name} in ${Instance.directory}: ${describe(error)}`]))
      .finally(() => deadline.removeEventListener("abort", expiry))

    const permission_denials = denials()
    if (!input.keep) {
      await Session.stop({ sessionID: session.id }).catch((error) =>
        log.error("headless stop failed", { sessionID: session.id, error }),
      )
      await Session.remove(session.id)
    }
    log.info("headless", {
      agent: agent.name,
      is_error: outcome.is_error,
      turns: outcome.num_turns,
      denials: permission_denials.length,
      cost: outcome.cost,
    })
    return {
      ...outcome,
      permission_denials,
      ...(input.keep && { session_id: session.id }),
    }
  }

  // A run lives only as long as the request that started it, so a headless
  // session created before this server started belongs to a run whose server
  // died and whose caller's connection died with it. Stop first: its jobs
  // outlive the server and would otherwise deliver into a removed session.
  export async function sweep(before: number) {
    const orphans = await Sessions.listEphemeral(before)
    for (const orphan of orphans) {
      await Instance.provide({
        directory: orphan.directory,
        fn: async () => {
          await Session.stop({ sessionID: orphan.id }).catch((error) =>
            log.error("headless sweep stop failed", { sessionID: orphan.id, error }),
          )
          await Session.remove(orphan.id)
        },
      }).catch((error) => log.error("headless sweep failed", { sessionID: orphan.id, error }))
    }
    if (orphans.length > 0) log.info("swept orphaned headless sessions", { count: orphans.length })
    return orphans.length
  }

  async function summarize(sessionID: string): Promise<Result> {
    const messages = await Session.messages({ sessionID })
    const assistants = messages.flatMap((m) =>
      m.info.role === "assistant" ? [m as MessageV2.WithParts & { info: MessageV2.Assistant }] : [],
    )
    const last = assistants.at(-1)
    const steps = messages.flatMap((m) =>
      m.parts.filter((p): p is MessageV2.StepFinishPart => p.type === "step-finish"),
    )
    const usage = steps.reduce(
      (sum, step) => ({
        input: sum.input + step.tokens.input,
        output: sum.output + step.tokens.output,
        reasoning: sum.reasoning + step.tokens.reasoning,
        cacheRead: sum.cacheRead + step.tokens.cache.read,
        cacheWrite: sum.cacheWrite + step.tokens.cache.write,
      }),
      EMPTY_USAGE,
    )
    const text = (last?.parts ?? [])
      .filter((p): p is MessageV2.TextPart => p.type === "text" && !p.synthetic)
      .map((p) => p.text)
      .join("")
    const error = last?.info.error
    const errors = error
      ? [`headless: ${error.name}: ${"message" in error.data ? error.data.message : JSON.stringify(error.data)}`]
      : []
    return {
      result: text,
      finish: last?.info.finish,
      num_turns: assistants.length,
      usage,
      cost: steps.reduce((sum, step) => sum + step.cost, 0),
      permission_denials: [],
      model: last ? `${last.info.providerID}/${last.info.modelID}` : undefined,
      is_error: errors.length > 0,
      errors,
    }
  }
}
