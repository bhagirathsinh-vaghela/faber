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
    abort?: AbortSignal
    /** Milliseconds before the call is abandoned. Defaults to 30s. */
    timeout?: number
  }

  const DEFAULT_TIMEOUT = 30_000

  /**
   * A caller-supplied instruction evaluated against caller-supplied text, with
   * none of the session's own context. Callers own the rules and the verdict
   * format; this only guarantees the clean prefix.
   *
   * Session instructions (AGENTS.md, environment, project) are passed empty so
   * the model weighs the caller's rules alone.
   */
  export async function run(input: Input) {
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
      // Model resolution is inside the try so a provider/registry failure here
      // fails open like any other, rather than throwing to the caller — the
      // "enforcement never ends the turn" guarantee covers the whole call.
      const configured = await Provider.defaultModel()
      const model = await Provider.getModel(configured.providerID, configured.modelID)

      const { stream } = await LLM.stream({
        agent,
        user: {
          id: "judge",
          sessionID: input.sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: model.providerID, modelID: model.id },
          variant: model.variant,
        } as MessageV2.User,
        model,
        tools: {},
        messages: [{ role: "user" as const, content: input.input }],
        system: { env: [], globalInstructions: [], projectInstructions: [] },
        sessionID: input.sessionID,
        abort: deadline.signal,
      })

      // Drive the stream to completion explicitly. text/usage resolve off the
      // collected steps but do NOT themselves consume the stream; only
      // finishReason (or this call) drains it. Consuming here means the reads
      // below cannot hang on an undrained stream if the awaited set ever changes.
      await stream.consumeStream()
      // Settle text, usage, and finishReason together so a text rejection does
      // not leave the other two unhandled (a process-level unhandledRejection).
      const [verdict, usage, finish] = await Promise.all([stream.text, stream.usage, stream.finishReason])
      // A judge call never lands in the session's message list, so this log is the
      // only place its cost is observable.
      log.info("judge", {
        model: model.id,
        chars: verdict.length,
        input: usage.inputTokens,
        output: usage.outputTokens,
        reasoning: usage.reasoningTokens,
        cacheRead: usage.cachedInputTokens,
        finish,
      })
      return verdict
    } catch (error) {
      // The judge is an enforcement gate, never the user's conversation. An
      // infrastructure failure here (500, network, timeout, abort) is not a
      // verdict and must never surface as a thrown tool error or end the turn, so
      // it fails open. A real verdict is the returned STRING from a successful
      // stream, so this cannot suppress a genuine deny; every caller reads the
      // empty string as inconclusive and allows the guarded work.
      log.error("judge failed, failing open", { error })
      return ""
    } finally {
      release()
    }
  }
}
