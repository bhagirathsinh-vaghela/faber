import { Provider } from "@/provider/provider"
import { PermissionNext } from "@/permission/next"
import { Log } from "@/util/log"
import { LLM } from "./llm"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"

export namespace SessionJudge {
  const log = Log.create({ service: "session.judge" })

  export type Input = {
    /** The full instruction the judge runs under. Becomes the only authored system block. */
    prompt: string
    /** The text being judged. */
    input: string
    sessionID: string
    model?: { providerID: string; modelID: string }
    abort?: AbortSignal
    /** Milliseconds before the call is abandoned. Defaults to 30s. */
    timeout?: number
    /** Completion budget. Defaults to 4096: enough for a verdict with a rewrite, small enough to bound the cost. */
    maxOutputTokens?: number
  }

  const DEFAULT_TIMEOUT = 30_000
  const DEFAULT_MAX_OUTPUT = 4_096

  /**
   * A caller-supplied instruction evaluated against caller-supplied text, with
   * none of the session's own context. Callers own the rules and the verdict
   * format; this only guarantees the clean prefix.
   *
   * Session instructions (AGENTS.md, environment, project) are passed empty so
   * the model weighs the caller's rules alone.
   */
  export async function run(input: Input) {
    const model = input.model
      ? await Provider.getModel(input.model.providerID, input.model.modelID)
      : await Provider.getSmallModel("anthropic")
    if (!model) throw new Error("no model available for judge")

    // An enforcement check must never outlive the tool call it guards, so the
    // call carries its own deadline rather than inheriting an open-ended one.
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), input.timeout ?? DEFAULT_TIMEOUT)
    // The caller's signal outlives this call, so the listener is detached when the
    // verdict settles; leaving it attached retains this whole invocation per judge.
    const onCallerAbort = () => deadline.abort()
    input.abort?.addEventListener("abort", onCallerAbort, { once: true })
    const release = () => {
      clearTimeout(timer)
      input.abort?.removeEventListener("abort", onCallerAbort)
    }

    const agent: Agent.Info = {
      name: "judge",
      mode: "primary",
      hidden: true,
      native: true,
      prompt: input.prompt,
      options: {},
      permission: PermissionNext.fromConfig({ "*": "deny" }),
    }

    try {
      const { stream } = await LLM.stream({
        agent,
        user: {
          id: "judge",
          sessionID: input.sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: model.providerID, modelID: model.id },
        } as MessageV2.User,
        model,
        // An explicit model is a deliberate capability choice, so only fall back to
        // the small-model options when the caller left the model unspecified.
        small: !input.model,
        // A verdict is a few lines. Under the beta headers the Anthropic
        // provider sends, a sonnet-class model thinks implicitly when the body
        // omits `thinking`, and measured against real rule checks that thinking
        // consumed the whole budget on 60 of 100 calls and returned an empty
        // reply, which the caller reads as an off-contract PASS. Disabling it is
        // what makes the cap safe.
        thinking: "disabled",
        maxOutputTokens: input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT,
        tools: {},
        messages: [{ role: "user" as const, content: input.input }],
        system: { env: [], globalInstructions: [], projectInstructions: [] },
        sessionID: input.sessionID,
        abort: deadline.signal,
        retries: 1,
      })

      const verdict = await stream.text
      // A judge call never lands in the session's message list, so this log is the
      // only place its cost is observable.
      const usage = await stream.usage
      log.info("judge", {
        model: model.id,
        chars: verdict.length,
        input: usage.inputTokens,
        output: usage.outputTokens,
        reasoning: usage.reasoningTokens,
        cacheRead: usage.cachedInputTokens,
        finish: await stream.finishReason,
      })
      return verdict
    } finally {
      release()
    }
  }
}
