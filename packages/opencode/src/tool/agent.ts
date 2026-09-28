import { Tool } from "./tool"
import DESCRIPTION from "./agent.txt"
import z from "zod"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { SessionPrompt } from "../session/prompt"
import { Recovery } from "../session/recovery"
import { Sessions } from "../storage/sessions"
import { Messages } from "../storage/messages"
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

      // The launch belongs to this turn: one a stop has cancelled, or is about
      // to (a stop stamps first and cancels last), launches nothing.
      const launched = Date.now()
      const halted = () => ctx.abort.aborted || Sessions.halted(ctx.sessionID, launched)
      if (await halted()) throw new Error(`session ${ctx.sessionID} was stopped before its subagent launched`)

      const session =
        found ??
        (await iife(async () => {
          const created = await Session.create({
            parentID: ctx.sessionID,
            title: params.description + ` (@${params.subagent_type} subagent)`,
          })
          return Session.update(created.id, (draft) => {
            draft.allowedTools = allowed
            draft.time.injected = 0
          })
        }))
      // A launch that fails from here on leaves a child that will not run for
      // it: a new child, or one whose prompt for this launch landed, is
      // stopped over that prompt rather than left owed with no turn. A
      // continued child the launch never reached is left as it was.
      const abandon = async (error: unknown) => {
        const prompted = (await Messages.reader()).prompted(session.id)
        if (!found || prompted >= launched)
          await Session.mark(session.id, (draft) => void (draft.time.stopped = Math.max(Date.now(), prompted)))
        throw error
      }
      const stopped = () => new Error(`session ${ctx.sessionID} was stopped before its subagent launched`)
      const parts = await prepare(session.id).catch(abandon)

      // Checked again after the awaits above: a stop that landed meanwhile has
      // already stamped this child, and a prompt written now would outrun it.
      if (await halted()) await abandon(stopped())

      // The prompt is the fact that makes the parent owed this child's result,
      // so it is written before the tool returns.
      const written = await SessionPrompt.prompt({
        sessionID: session.id,
        model: parts.model,
        agent: agent.name,
        tools: {},
        parts: parts.prompt,
        noReply: true,
      }).catch(abandon)

      // A continued child reports from this prompt on: whatever it answered
      // before was already its parent's, or never will be. After the prompt,
      // so a launch that fails to write it leaves the earlier result owed;
      // `max` keeps a delivery that just landed.
      if (found)
        await Session.update(found.id, (draft) => {
          draft.time.injected = Math.max(draft.time.injected ?? 0, launched - 1)
        }).catch(abandon)

      // A stop stamps parent before child and every stamp before any cancel
      // (Session.stop). So the parent is read first and the child last, with
      // nothing awaited between that read and the turn's start: a child read
      // unstamped means its cancel comes after the turn below is registered,
      // and its stamp after the prompt, so the child is owed nothing.
      if (await halted()) await abandon(stopped())
      const child = await Sessions.read(session.id).catch(abandon)
      if ((child.time.stopped ?? 0) >= launched) await abandon(stopped())

      // Fire and forget. Recovery delivers the result once the child is done,
      // however many restarts that takes.
      void SessionPrompt.loop(session.id).catch(async (error) => {
        log.error("subagent turn failed", { sessionID: session.id, error })
        const message = error instanceof Error ? error.message : String(error)
        await Recovery.fail(session.id, message, launched, written.info.time.created).catch(
          (failure) => log.error("could not report the failed subagent", { sessionID: session.id, error: failure }),
        )
      })

      return {
        title: params.description,
        metadata: {
          status: "async_launched",
          subagentId: session.id,
          sessionId: session.id,
          model: parts.model,
          toolset: params.toolset,
          tools: allowed,
          summary: params.summary,
        } as Record<string, unknown>,
        output: [
          `Background subagent started: ${params.description}`,
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

      // Everything the prompt needs, read before it is written: the parent's
      // conversation copied into a new child (shared context, cache reuse),
      // the caller's model, and the resolved parts.
      async function prepare(childID: string) {
        const copied = params.include_context && !found ? await Session.messages({ sessionID: ctx.sessionID }) : []
        const ids = new Map<string, string>()
        for (const parentMsg of copied) {
          const newID = Identifier.ascending("message")
          ids.set(parentMsg.info.id, newID)
          const parentID =
            parentMsg.info.role === "assistant" && parentMsg.info.parentID
              ? ids.get(parentMsg.info.parentID)
              : undefined
          // Dated before the child existed, however late the parent wrote it:
          // recovery counts only messages from the child's creation on as its
          // own prompts, and a copied one must never pass for the real prompt.
          await Session.updateMessage({
            ...parentMsg.info,
            sessionID: childID,
            id: newID,
            time: { ...parentMsg.info.time, created: Math.min(parentMsg.info.time.created, session.time.created - 1) },
            ...(parentID && { parentID }),
          })
          for (const part of parentMsg.parts) {
            await Session.updatePart({
              ...part,
              id: Identifier.ascending("part"),
              messageID: newID,
              sessionID: childID,
            })
          }
        }
        const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
        if (msg.info.role !== "assistant")
          throw new Error(`message ${ctx.messageID} calling the agent tool is not an assistant message`)
        return {
          model: { modelID: msg.info.modelID, providerID: msg.info.providerID },
          prompt: await SessionPrompt.resolvePromptParts(params.prompt),
        }
      }
    },
  }
})
