import z from "zod"
import { Provider } from "@/provider/provider"
import { PermissionNext } from "@/permission/next"
import { Identifier } from "@/id/id"
import { Log } from "@/util/log"
import type { Agent } from "@/agent/agent"
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
    cache: z.boolean().optional().describe("Place prompt-cache markers. Off by default."),
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

  /**
   * One model call: the caller's system prompt and prompt in, the model's text
   * out. No session, no tools, no instructions, nothing persisted.
   */
  export async function run(input: Input): Promise<Result> {

    const agent: Agent.Info = {
      name: "oneshot",
      mode: "primary",
      hidden: true,
      native: true,
      prompt: input.system,
      options: {},
      permission: PermissionNext.fromConfig({ "*": "deny" }),
    }
    const model = await resolveModel(agent, input.model).catch((error) => error as Error)
    if (model instanceof Error) return failure([`oneshot: model "${input.model}": ${model.message}`])
    if (input.variant !== Provider.DEFAULT && !model.variants?.[input.variant])
      return failure([`oneshot: model ${model.providerID}/${model.id} offers no variant "${input.variant}"`])

    const variant =
      input.variant === Provider.DEFAULT
        ? (await SessionPrompt.defaults(agent, { providerID: model.providerID, modelID: model.id })).variant
        : input.variant
    const outcome = await call(input, agent, model, variant).catch((error) =>
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
    const sessionID = Identifier.ascending("session")
    const { stream } = await LLM.stream({
      agent,
      user: {
        id: Identifier.ascending("message"),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: agent.name,
        model: { providerID: model.providerID, modelID: model.id },
        variant,
      } as MessageV2.User,
      model,
      sessionID,
      tools: {},
      messages: [{ role: "user", content: input.prompt }],
      system: { env: [], globalInstructions: [], projectInstructions: [] },
      abort: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT),
      cache: input.cache ?? false,
    })

    const errors: string[] = []
    for await (const part of stream.fullStream) {
      if (part.type === "error") errors.push(`oneshot: ${model.providerID}/${model.id}: ${describe(part.error)}`)
    }
    if (errors.length > 0) return failure(errors)

    const [text, finish, steps] = await Promise.all([stream.text, stream.finishReason, stream.steps])
    const usages = steps.map((step) => Session.getUsage({ model, usage: step.usage, metadata: step.providerMetadata }))
    const costs = await Promise.all(usages.map((u) => u.cost))
    return {
      result: text,
      finish,
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
      cost: costs.reduce((sum, c) => sum + c, 0),
      is_error: false,
      errors: [],
    }
  }
}
