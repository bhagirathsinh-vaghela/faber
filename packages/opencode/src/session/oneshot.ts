import z from "zod"
import { Provider } from "@/provider/provider"
import { PermissionNext } from "@/permission/next"
import { Identifier } from "@/id/id"
import { Log } from "@/util/log"
import type { Agent } from "@/agent/agent"
import type { LanguageModelUsage, ProviderMetadata } from "ai"
import type { MessageV2 } from "./message-v2"
import { LLM } from "./llm"
import { SessionPrompt } from "./prompt"
import { Session } from "."

export namespace Oneshot {
  const log = Log.create({ service: "oneshot" })

  const DEFAULT_TIMEOUT = 120_000

  export const Input = z.object({
    system: z.string().optional(),
    prompt: z.string().min(1),
    model: z.string().describe('provider/model, or "default" for the configured model'),
    variant: z.string().describe('A variant the model offers, or "default" for the model\'s configured one'),
    cache: z
      .boolean()
      .optional()
      .describe(
        "Cache the system prompt: one 1h marker on it and none on the prompt, which is never re-sent. Off by default; turn it on only for a system prompt reused across calls.",
      ),
    timeoutMs: z.number().int().positive().optional(),
  })
  export type Input = z.infer<typeof Input>

  export const Usage = z.object({
    input: z.number(),
    output: z.number(),
    reasoning: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
  })

  export const Result = z.object({
    result: z.string(),
    finish: z.string().optional(),
    usage: Usage,
    cost: z.number(),
    model: z.string().optional(),
    is_error: z.boolean(),
    errors: z.array(z.string()),
  })
  export type Result = z.infer<typeof Result>

  const EMPTY_USAGE = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }

  function failure(errors: string[]): Result {
    return { result: "", usage: EMPTY_USAGE, cost: 0, is_error: true, errors }
  }

  function describe(error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }

  async function resolveModel(agent: Agent.Info, model: string) {
    const ref = model === Provider.DEFAULT ? (await SessionPrompt.defaults(agent)).model : Provider.parseModel(model)
    return Provider.getModel(ref.providerID, ref.modelID)
  }

  function persona(system: string | undefined): Agent.Info {
    return {
      name: "oneshot",
      mode: "primary",
      hidden: true,
      native: true,
      prompt: system,
      options: {},
      permission: PermissionNext.fromConfig({ "*": "deny" }),
    }
  }

  // The model and the variant the call runs on, or the reason it cannot run.
  async function resolve(
    agent: Agent.Info,
    input: { model: string; variant: string },
  ): Promise<{ model: Provider.Model; variant: string | undefined } | string> {
    const model = await resolveModel(agent, input.model).catch((error) => error as Error)
    if (model instanceof Error) return `oneshot: model "${input.model}": ${model.message}`
    if (input.variant !== Provider.DEFAULT && !model.variants?.[input.variant])
      return `oneshot: model ${model.providerID}/${model.id} offers no variant "${input.variant}"`
    if (input.variant !== Provider.DEFAULT) return { model, variant: input.variant }
    const defaults = await SessionPrompt.defaults(agent, { providerID: model.providerID, modelID: model.id }).catch(
      (error) => error as Error,
    )
    if (defaults instanceof Error) return `oneshot: model ${model.providerID}/${model.id}: ${defaults.message}`
    return { model, variant: defaults.variant }
  }

  /**
   * The provider/model and variant a call with these settings runs on, with
   * "default" resolved, or the reason it cannot run.
   */
  export async function target(input: { system?: string; model: string; variant: string }) {
    const resolved = await resolve(persona(input.system), input)
    if (typeof resolved === "string") return resolved
    return { model: `${resolved.model.providerID}/${resolved.model.id}`, variant: resolved.variant }
  }

  function open(input: {
    agent: Agent.Info
    model: Provider.Model
    variant: string | undefined
    sessionID: string
    prompt: string
    abort: AbortSignal
    cache: boolean | undefined
  }) {
    return LLM.stream({
      agent: input.agent,
      user: {
        id: Identifier.ascending("message"),
        sessionID: input.sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: input.agent.name,
        model: { providerID: input.model.providerID, modelID: input.model.id },
        variant: input.variant,
      } as MessageV2.User,
      model: input.model,
      sessionID: input.sessionID,
      tools: {},
      messages: [{ role: "user", content: input.prompt }],
      system: { env: [], globalInstructions: [], projectInstructions: [] },
      bare: true,
      abort: input.abort,
      cache: input.cache ? "system" : false,
    })
  }

  async function spend(
    model: Provider.Model,
    steps: { usage: LanguageModelUsage; providerMetadata?: ProviderMetadata }[],
  ) {
    const usages = steps.map((step) => Session.getUsage({ model, usage: step.usage, metadata: step.providerMetadata }))
    return {
      usage: usages.reduce(
        (sum, u) => ({
          input: sum.input + u.tokens.input,
          output: sum.output + u.tokens.output,
          reasoning: sum.reasoning + u.tokens.reasoning,
          cacheRead: sum.cacheRead + u.tokens.cache.read,
          cacheWrite: sum.cacheWrite + u.tokens.cache.write,
        }),
        EMPTY_USAGE,
      ),
      cost: (await Promise.all(usages.map((u) => u.cost))).reduce((sum, c) => sum + c, 0),
    }
  }

  /**
   * One model call: the caller's system prompt and prompt in, the model's text
   * out. No session, no tools, no instructions, nothing persisted.
   */
  export async function run(input: Input): Promise<Result> {
    const agent = persona(input.system)
    const resolved = await resolve(agent, input)
    if (typeof resolved === "string") return failure([resolved])
    const model = resolved.model
    const outcome = await call(input, agent, model, resolved.variant).catch((error) =>
      failure([`oneshot: ${model.providerID}/${model.id}: ${describe(error)}`]),
    )
    log.info("oneshot", {
      model: model.id,
      is_error: outcome.is_error,
      input: outcome.usage.input,
      output: outcome.usage.output,
      cost: outcome.cost,
    })
    return { ...outcome, model: `${model.providerID}/${model.id}` }
  }

  async function call(
    input: Input,
    agent: Agent.Info,
    model: Provider.Model,
    variant: string | undefined,
  ): Promise<Result> {
    const { stream } = await open({
      agent,
      model,
      variant,
      sessionID: Identifier.ascending("session"),
      prompt: input.prompt,
      abort: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT),
      cache: input.cache,
    })

    const errors: string[] = []
    for await (const part of stream.fullStream) {
      if (part.type === "error") errors.push(`oneshot: ${model.providerID}/${model.id}: ${describe(part.error)}`)
    }
    if (errors.length > 0) return failure(errors)

    const [text, finish, steps] = await Promise.all([stream.text, stream.finishReason, stream.steps])
    const spent = await spend(model, steps)
    return { result: text, finish, ...spent, is_error: false, errors: [] }
  }

  export type StreamInput = {
    system: string
    prompt: string
    model: string
    variant: string
    cache?: boolean
    /** The session the call runs under. */
    sessionID: string
    abort: AbortSignal
  }

  export type Event =
    | { type: "text"; text: string }
    | {
        type: "done"
        finish: string
        model: string
        usage: z.infer<typeof Usage>
        cost: number
        /** Reasoning parts the model produced; dropped from the text (ai 5.0.124 fullStream: reasoning-* parts are separate from text-delta). */
        thoughts: number
      }
    | { type: "error"; message: string }

  /**
   * One model call streamed: only the model's answer text arrives as "text",
   * then exactly one "done" or "error". Any finish other than stop is an error
   * (AI SDK v5 finishReason: stop, length, content-filter, tool-calls, error,
   * other, unknown; @ai-sdk/provider 2.0.1), so a truncated answer is never
   * mistaken for a complete one.
   */
  export async function* stream(input: StreamInput): AsyncGenerator<Event> {
    const agent = persona(input.system)
    const resolved = await resolve(agent, input)
    if (typeof resolved === "string") {
      log.info("oneshot stream", { model: input.model, is_error: true, error: resolved })
      return yield { type: "error", message: resolved }
    }
    const model = resolved.model
    const name = `${model.providerID}/${model.id}`
    const fail = (why: string): Event => {
      const message = `oneshot: ${name}: ${why}`
      log.info("oneshot stream", { model: model.id, is_error: true, error: message })
      return { type: "error", message }
    }

    const opened = await open({
      agent,
      model,
      variant: resolved.variant,
      sessionID: input.sessionID,
      prompt: input.prompt,
      abort: input.abort,
      cache: input.cache,
    }).catch((error) => error as Error)
    if (opened instanceof Error) return yield fail(describe(opened))

    const steps: { usage: LanguageModelUsage; providerMetadata?: ProviderMetadata }[] = []
    const state = { thoughts: 0, finish: undefined as string | undefined }
    const parts = opened.stream.fullStream[Symbol.asyncIterator]()
    while (true) {
      const next = await parts.next().catch((error) => error as Error)
      if (next instanceof Error) return yield fail(describe(next))
      if (next.done) break
      const part = next.value
      if (part.type === "text-delta") yield { type: "text", text: part.text }
      if (part.type === "reasoning-start") state.thoughts++
      if (part.type === "finish-step") steps.push(part)
      if (part.type === "finish") state.finish = part.finishReason
      if (part.type === "error") return yield fail(describe(part.error))
      if (part.type === "abort") return yield fail(`aborted: ${describe(input.abort.reason ?? "no reason given")}`)
    }
    // Stricter than run, which returns any finish: streamed text is acted on as it arrives, so truncation must fail loudly.
    if (state.finish !== "stop")
      return yield fail(`finished with "${state.finish ?? "no finish"}" instead of a normal stop`)
    const spent = await spend(model, steps).catch((error) => error as Error)
    if (spent instanceof Error) return yield fail(`cost: ${describe(spent)}`)
    log.info("oneshot stream", {
      model: model.id,
      thoughts: state.thoughts,
      ...spent.usage,
      cost: spent.cost,
    })
    yield { type: "done", finish: state.finish, model: name, ...spent, thoughts: state.thoughts }
  }
}
