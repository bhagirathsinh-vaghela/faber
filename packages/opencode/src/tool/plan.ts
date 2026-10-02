import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Question } from "../question"
import { Session } from "../session"
import { Provider } from "../provider/provider"
import { SessionPrompt } from "../session/prompt"
import { Instance } from "../project/instance"
import EXIT_DESCRIPTION from "./plan-exit.txt"
import ENTER_DESCRIPTION from "./plan-enter.txt"

type Switch = {
  agent: "plan" | "build"
  question: string
  header: string
  yes: string
  no: string
  prompt: string
  title: string
  output: string
  stay: string
}

async function confirm(ctx: Tool.Context, target: Switch) {
  const answers = await Question.ask({
    sessionID: ctx.sessionID,
    questions: [
      {
        question: target.question,
        header: target.header,
        options: [
          { label: "Yes", description: target.yes },
          { label: "No", description: target.no },
        ],
      },
    ],
    tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
  })
  const answer = answers[0]?.[0]?.trim() ?? ""
  if (answer === "No") throw new Question.RejectedError()
  if (answer !== "Yes")
    return {
      title: target.stay,
      output: answer
        ? `The user did not switch. Their reply, which you should act on before asking again:\n\n${answer}`
        : "The user gave no answer, so nothing switched.",
      metadata: {},
    }

  await SessionPrompt.deliver({
    sessionID: ctx.sessionID,
    parts: [{ type: "text", text: target.prompt, synthetic: true, internal: true }],
    model: Provider.INHERIT,
    variant: Provider.INHERIT,
    params: { agent: target.agent },
    join: true,
    wake: false,
  })
  await Session.setAgent(ctx.sessionID, target.agent)
  return { title: target.title, output: target.output, metadata: {} }
}

async function planPath(sessionID: string) {
  return path.relative(Instance.worktree, Session.plan(await Session.get(sessionID)))
}

export const PlanExitTool = Tool.define("plan_exit", {
  description: EXIT_DESCRIPTION,
  parameters: z.object({}),
  async execute(_params, ctx) {
    const plan = await planPath(ctx.sessionID)
    return confirm(ctx, {
      agent: "build",
      question: `Plan at ${plan} is complete. Would you like to switch to the build agent and start implementing?`,
      header: "Build Agent",
      yes: "Switch to build agent and start implementing the plan",
      no: "Stay with plan agent to continue refining the plan",
      prompt: `The plan at ${plan} has been approved, you can now edit files. Execute the plan`,
      title: "Switching to build agent",
      output: "User approved switching to build agent. Wait for further instructions.",
      stay: "Staying in plan mode",
    })
  },
})

export const PlanEnterTool = Tool.define("plan_enter", {
  description: ENTER_DESCRIPTION,
  parameters: z.object({}),
  async execute(_params, ctx) {
    const plan = await planPath(ctx.sessionID)
    return confirm(ctx, {
      agent: "plan",
      question: `Would you like to switch to the plan agent and create a plan saved to ${plan}?`,
      header: "Plan Mode",
      yes: "Switch to plan agent for research and planning",
      no: "Stay with build agent to continue making changes",
      prompt: "User has requested to enter plan mode. Switch to plan mode and begin planning.",
      title: "Switching to plan agent",
      output: `User confirmed to switch to plan mode. A new message has been created to switch you to plan mode. The plan file will be at ${plan}. Begin planning.`,
      stay: "Staying in build mode",
    })
  },
})
