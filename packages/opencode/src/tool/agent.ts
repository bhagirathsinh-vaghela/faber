import { Tool } from "./tool"
import DESCRIPTION from "./agent.txt"
import z from "zod"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { Provider } from "../provider/provider"
import { Agent } from "../agent/agent"
import { SessionPrompt } from "../session/prompt"
import { iife } from "@/util/iife"
import { PermissionNext } from "@/permission/next"
import { Config } from "@/config/config"
import { Log } from "@/util/log"

const log = Log.create({ service: "subagent-tool" })

const parameters = z
  .object({
    description: z
      .string()
      .describe(
        "A short identifier for this subagent, AT MOST 5 words (e.g. 'count repo files', 'audit auth flow'). It labels the subagent on both its launch card and its result card, so keep it terse and specific — it is how the user tells one subagent apart from another. Put the fuller ask in `summary`, not here.",
      ),
    prompt: z.string().describe("The task for the agent to perform"),
    summary: z
      .string()
      .describe(
        "A one-sentence TL;DR of what the subagent is being asked to do, so the main thread and user can see the ask without reading the full prompt. ALWAYS provide this when invoking the agent tool. MUST faithfully reflect the prompt — do not editorialize or add intent the prompt does not contain.",
      )
      .optional(),
    subagent_type: z.string().describe("The type of specialized agent to use for this task"),
    toolset: z
      .string()
      .describe(
        "The named tool preset the subagent runs with. Must be one of the toolsets listed in this tool's description.",
      ),
    session_id: z.string().describe("Existing subagent session to continue").optional(),
    include_context: z
      .boolean()
      .describe(
        "When true, the subagent inherits the parent conversation history for shared context and prompt cache reuse",
      )
      .optional(),
    command: z.string().describe("The command that triggered this task").optional(),
  })
  .strict()

export const AgentTool = Tool.define("agent", async (ctx) => {
  const snapshot = ctx?.snapshot
  const agents = (snapshot?.agentList ?? (await Agent.list())).filter((a) => a.mode !== "primary")

  // Filter agents by permissions if agent provided
  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => PermissionNext.evaluate("agent", a.name, caller.permission).action !== "deny")
    : agents

  // Repo-scoped agents are listed in a durable message block instead, keeping
  // this description equal across projects so the tools[] prefix Anthropic
  // hashes first can be shared between them.
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
          permission: "agent",
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

      // Only this caller's own subagent can be continued: its result is
      // delivered to its parent, which must be the session asking.
      const found = params.session_id ? await Session.get(params.session_id).catch(() => undefined) : undefined
      if (params.session_id && found?.parentID !== ctx.sessionID) {
        return {
          title: params.description,
          metadata: {} as Record<string, unknown>,
          output: found
            ? `Session ${params.session_id} is not a subagent of this session, so it cannot be continued here. Omit session_id to start a new subagent.`
            : `Session ${params.session_id} does not exist. Omit session_id to start a new subagent.`,
        }
      }

      // The launch belongs to this turn: one an Esc or Stop has cancelled
      // launches nothing.
      const stopped = () => new Error(`session ${ctx.sessionID} was stopped before its subagent launched`)
      if (ctx.abort.aborted) throw stopped()

      const session =
        found ??
        (await iife(async () => {
          const created = await Session.create({
            parentID: ctx.sessionID,
            title: params.description + ` (@${params.subagent_type} subagent)`,
          })
          return Session.update(created.id, (draft) => void (draft.allowedTools = allowed))
        }))
      // A child this call made goes with a failed preparation, so no orphan
      // (possibly a copy of the caller's transcript) is left behind.
      const parts = await prepare(session.id, !found && params.include_context ? ctx.sessionID : undefined).catch(
        async (error) => {
          if (!found) await Session.remove(session.id)
          throw error
        },
      )

      // Checked again after the awaits above, before anything is written into
      // the child: a child this call made goes with nothing owed.
      if (ctx.abort.aborted) {
        if (!found) await Session.remove(session.id)
        throw stopped()
      }

      // Written like any message into a subagent, whose write opens the
      // child's debt or joins the one still open. Its turn is the typed
      // prompt's: a steer into a busy child asks again once the running turn
      // ends, and a failed turn reports itself. Recovery delivers the result
      // once the child is done, however many restarts that takes.
      const sent = await SessionPrompt.send({
        sessionID: session.id,
        model: parts.model,
        variant: parts.variant ?? (found ? Provider.INHERIT : Provider.DEFAULT),
        agent: agent.name,
        tools: {},
        parts: parts.prompt,
      })
      sent.answer.catch((error) => log.error("subagent turn failed", { sessionID: session.id, error }))

      // Only a Stop after the write abandons the launch; an Esc lets it run,
      // since the child's turn is its own. A child this call made goes, and
      // its debt with it: its turn is cancelled and settles before the child
      // is removed, so nothing writes into a deleted session. A continued or
      // steered child is left to the Stop, whose walk of the subtree reaches it;
      // a write that lands after that walk started is the accepted case of a
      // message written during a Stop, which may start a turn stopped by hand.
      if (ctx.abort.reason === SessionPrompt.STOPPED && !found) {
        SessionPrompt.cancel(session.id, SessionPrompt.STOPPED)
        await sent.answer.catch(() => undefined)
        await Session.remove(session.id)
        throw stopped()
      }
      const mode = sent.message.debt === "joined" ? "steered" : found ? "continued" : "launched"

      return {
        title: params.description,
        metadata: {
          status: "async_launched",
          // Everything the launcher card shows; it never reads `output`.
          mode,
          description: params.description,
          summary: params.summary,
          subagentType: params.subagent_type,
          // Whether THIS call copied the caller's conversation: a prompt into
          // an existing child carries that child's own transcript instead.
          includeContext: !found && !!params.include_context,
          toolset: params.toolset,
          tools: allowed,
          subagentId: session.id,
          sessionId: session.id,
          model: parts.model,
        } as Record<string, unknown>,
        output: [
          {
            steered: `Prompt delivered to the running subagent: ${params.description}. It reports once, covering both asks.`,
            continued: `Subagent continued: ${params.description}. It reports again once it answers.`,
            launched: `Background subagent started: ${params.description}`,
          }[mode],
          `agent: ${agent.name}`,
          `toolset: ${params.toolset} (${allowed.join(", ")})`,
          ...(params.summary ? [`summary: ${params.summary}`] : []),
          `subagent_id: ${session.id}`,
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

      // Everything the prompt needs, read before it is written: the caller's
      // conversation copied into a new child from `source` (shared context,
      // cache reuse), the caller's model and variant, and the resolved parts.
      async function prepare(childID: string, source: string | undefined) {
        if (source) await Session.copy(source, childID)
        const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
        if (msg.info.role !== "assistant")
          throw new Error(`message ${ctx.messageID} calling the agent tool is not an assistant message`)
        return {
          model: { modelID: msg.info.modelID, providerID: msg.info.providerID },
          variant: msg.info.variant,
          prompt: await SessionPrompt.resolvePromptParts(params.prompt),
        }
      }
    },
  }
})
