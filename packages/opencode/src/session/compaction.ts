import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Session } from "."
import { Identifier } from "../id/id"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { MessageV2 } from "./message-v2"
import z from "zod"
import { SessionPrompt } from "./prompt"
import { Token } from "../util/token"
import { Log } from "../util/log"
import { SessionProcessor } from "./processor"
import { fn } from "@/util/fn"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { SystemPrompt } from "./system"
import { SessionPin } from "./pin"

export namespace SessionCompaction {
  const log = Log.create({ service: "session.compaction" })

  export const Event = {
    Compacted: BusEvent.define(
      "session.compacted",
      z.object({
        sessionID: z.string(),
      }),
    ),
  }

  export async function isOverflow(input: { tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
    const config = await Config.get()
    if (config.compaction?.auto === false) return false
    const context = input.model.limit.context
    if (context === 0) return false
    const count = input.tokens.input + input.tokens.cache.read + input.tokens.output
    const output = Math.min(input.model.limit.output, SessionPrompt.OUTPUT_TOKEN_MAX) || SessionPrompt.OUTPUT_TOKEN_MAX
    const usable = input.model.limit.input || context - output
    // The usable window still caps the threshold: a fraction that lands above it
    // would let the request reach the API and be rejected there instead of
    // compacting.
    const threshold = config.compaction?.threshold
    return count > (threshold ? Math.min(context * threshold, usable) : usable)
  }

  export const PRUNE_MINIMUM = 20_000
  export const PRUNE_PROTECT = 40_000

  const PRUNE_PROTECTED_TOOLS = ["skill"]

  // goes backwards through parts until there are 40_000 tokens worth of tool
  // calls. then erases output of previous tool calls. idea is to throw away old
  // tool calls that are no longer relevant.
  export async function prune(input: { sessionID: string }) {
    const config = await Config.get()
    if (config.compaction?.prune === false) return
    log.info("pruning")
    const msgs = await Session.messages({ sessionID: input.sessionID })
    let total = 0
    let pruned = 0
    const toPrune = []
    let turns = 0

    loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
      const msg = msgs[msgIndex]
      if (msg.info.role === "user") turns++
      if (turns < 2) continue
      if (msg.info.role === "assistant" && msg.info.summary) break loop
      for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
        const part = msg.parts[partIndex]
        if (part.type === "tool")
          if (part.state.status === "completed") {
            if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue

            if (part.state.time.compacted) break loop
            const estimate = Token.estimate(part.state.output)
            total += estimate
            if (total > PRUNE_PROTECT) {
              pruned += estimate
              toPrune.push(part)
            }
          }
      }
    }
    log.info("found", { pruned, total })
    if (pruned > PRUNE_MINIMUM) {
      for (const part of toPrune) {
        if (part.state.status === "completed") {
          part.state.time.compacted = Date.now()
          await Session.updatePart(part)
        }
      }
      log.info("pruned", { count: toPrune.length })
    }
  }

  export async function process(input: {
    parentID: string
    messages: MessageV2.WithParts[]
    sessionID: string
    abort: AbortSignal
  }) {
    const userMessage = input.messages.findLast((m) => m.info.id === input.parentID)!.info as MessageV2.User
    const session = await Session.get(input.sessionID)
    // Use the session's real agent (build/plan) so the request prefix — provider
    // prompt (S1), tools, system blocks — is byte-identical to a normal turn.
    // Anthropic caches on a cumulative prefix hash; the compaction agent's own
    // prompt would replace S1 and invalidate the whole cached prefix (0% hit on
    // the largest request in the session). The "summarize, no tools" instruction
    // instead rides in the trailing user message, and allowedTools: [] is the
    // runtime guard that blocks any tool the model attempts.
    const snapshot = await SessionPin.get(input.sessionID)
    const agent = await SessionPrompt.resolveAgent(userMessage.agent, snapshot)
    const model = await Provider.getModel(userMessage.model.providerID, userMessage.model.modelID)
    const msg = (await Session.updateMessage({
      id: Identifier.ascending("message"),
      role: "assistant",
      parentID: input.parentID,
      sessionID: input.sessionID,
      mode: "compaction",
      agent: "compaction",
      summary: true,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      cost: 0,
      tokens: {
        output: 0,
        input: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: model.id,
      providerID: model.providerID,
      time: {
        created: Date.now(),
      },
    })) as MessageV2.Assistant
    const processor = SessionProcessor.create({
      assistantMessage: msg,
      sessionID: input.sessionID,
      model,
      abort: input.abort,
    })

    // Resolve the same tools as a normal turn so the tools[] block (front of the
    // prefix hash) is byte-identical. allowedTools: [] disables every tool at
    // execution time without removing it from the schema — a runtime guard that,
    // unlike a permission deny, can never strip a tool from the wire. Scoped to
    // this call only (shallow copy); the stored session keeps its allowedTools.
    const tools = await SessionPrompt.resolveTools({
      agent,
      model,
      session: { ...session, allowedTools: [] },
      processor,
      bypassAgentCheck: false,
      messages: input.messages,
      snapshot,
    })
    const instructions = snapshot.instructions
    const system = {
      env: SystemPrompt.environment(),
      globalInstructions: instructions.global,
      projectInstructions: instructions.project,
      sessionContext: SystemPrompt.sessionContext({
        created: session.time.created,
        branch: session.branch,
      }),
    }

    // Allow plugins to inject context or replace compaction prompt
    const compacting = await Plugin.trigger(
      "experimental.session.compacting",
      { sessionID: input.sessionID },
      { context: [], prompt: undefined },
    )
    // The summarization instruction lives here, in the trailing user message —
    // after the cached prefix — so it never disturbs the prefix hash. No tools are
    // available for this task (allowedTools: [] enforces it at runtime); the nudge
    // tells the model not to bother attempting one and to reply with text only.
    const defaultPrompt = [
      "Provide a detailed summary of our conversation so it can be continued in a fresh context.",
      "You will see tool definitions in this request, but NO tools are available to you for this task — any tool call will be denied. Do not attempt to use tools. Respond with the summary as plain text only.",
      "Structure the summary in these numbered sections, in order:",
      [
        "1. Primary Request and Intent: The user's explicit requests and goals, in detail. What are they ultimately trying to accomplish.",
        "2. Key Technical Concepts: The technologies, frameworks, patterns, and domain concepts in play.",
        '3. Files and Code: The specific files examined, modified, or created — always by exact path (e.g. packages/app/src/context/sync.tsx, never "the sync module"). For each, note why it matters and include the important code (signatures, the changed lines). Name branches, PR numbers, and ticket IDs exactly; never generalize an identifier.',
        '4. Errors and Fixes: Every error hit and how it was resolved, INCLUDING any user feedback or correction on it (e.g. "the user told me to do X differently"). This is what stops the next context from re-walking a dead end.',
        "5. Decisions and Rejected Alternatives: Each decision and its reasoning, AND the alternatives that were considered and ruled out, with why. Rejected approaches are as important as the chosen one — without them the ruled-out path gets re-attempted.",
        "6. Problem Solving: Problems solved and any ongoing troubleshooting still in flight.",
        "7. Pending Tasks vs. Open Threads: Separate (a) tasks the user explicitly asked for that are not yet done from (b) unresolved questions or discussions raised but not concluded.",
        "8. Current Work: Precisely what was being worked on immediately before this summary, with exact file paths and code where applicable.",
        "9. Next Step: The single next step, DIRECTLY in line with the user's most recent explicit request and the work in progress. Include a verbatim quote of where things left off so the task is not re-interpreted. Do not invent tangential next steps; if the last task concluded, say so rather than inventing one.",
      ].join("\n"),
      "Be comprehensive enough to preserve context, but concise enough to scan quickly.",
    ].join("\n\n")
    const promptText = compacting.prompt ?? [defaultPrompt, ...compacting.context].join("\n\n")
    const result = await processor.process({
      user: userMessage,
      agent,
      abort: input.abort,
      sessionID: input.sessionID,
      tools,
      system,
      messages: [
        ...MessageV2.toModelMessages(input.messages, model).messages,
        {
          role: "user",
          content: [
            {
              type: "text",
              text: promptText,
            },
          ],
        },
      ],
      model,
    })

    if (result === "continue") {
      const continueMsg = await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID: input.sessionID,
        time: {
          created: Date.now(),
        },
        // The nudge is infrastructure, not a human prompt, so it must not count
        // toward the title, the prompt ordinal, or any "last real user message"
        // lookup.
        synthetic: true,
        ...MessageV2.inherit(userMessage),
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: continueMsg.id,
        sessionID: input.sessionID,
        type: "text",
        synthetic: true,
        text: "Continue if you have next steps",
        time: {
          start: Date.now(),
          end: Date.now(),
        },
      })
    }
    if (processor.message.error) return "stop"
    // filterCompacted drops all pre-summary history, including the durable
    // <mcp_tool_catalog> block. Clear the session's last-injected catalog text so
    // the content-compare in insertMcpCatalog differs on the next (post-summary)
    // turn and re-injects a fresh block.
    await Session.update(input.sessionID, (draft) => void (draft.mcpCatalogText = ""), { touch: false })
    Bus.publish(Event.Compacted, { sessionID: input.sessionID })
    return "continue"
  }

  export const create = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      agent: z.string(),
      model: z.object({
        providerID: z.string(),
        modelID: z.string(),
      }),
      auto: z.boolean(),
    }),
    async (input) => {
      const msg = await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        variant: await MessageV2.lastVariant(input.sessionID),
        time: {
          created: Date.now(),
        },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
      })
    },
  )
}
