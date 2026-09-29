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

export const PlanExitTool = Tool.define("plan_exit", {
  description: EXIT_DESCRIPTION,
  parameters: z.object({}),
  async execute(_params, ctx) {
    const session = await Session.get(ctx.sessionID)
    const plan = path.relative(Instance.worktree, Session.plan(session))
    const answers = await Question.ask({
      sessionID: ctx.sessionID,
      questions: [
        {
          question: `Plan at ${plan} is complete. Would you like to switch to the build agent and start implementing?`,
          header: "Build Agent",
          custom: false,
          options: [
            { label: "Yes", description: "Switch to build agent and start implementing the plan" },
            { label: "No", description: "Stay with plan agent to continue refining the plan" },
          ],
        },
      ],
      tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
    })

    const answer = answers[0]?.[0]
    if (answer === "No") throw new Question.RejectedError()

    await SessionPrompt.deliver({
      sessionID: ctx.sessionID,
      parts: [
        {
          type: "text",
          text: `The plan at ${plan} has been approved, you can now edit files. Execute the plan`,
          synthetic: true,
          internal: true,
        },
      ],
      model: Provider.INHERIT,
      variant: Provider.INHERIT,
      params: { agent: "build" },
      join: true,
      wake: false,
    })
    await Session.setAgent(ctx.sessionID, "build")

    return {
      title: "Switching to build agent",
      output: "User approved switching to build agent. Wait for further instructions.",
      metadata: {},
    }
  },
})

export const PlanEnterTool = Tool.define("plan_enter", {
  description: ENTER_DESCRIPTION,
  parameters: z.object({}),
  async execute(_params, ctx) {
    const session = await Session.get(ctx.sessionID)
    const plan = path.relative(Instance.worktree, Session.plan(session))

    const answers = await Question.ask({
      sessionID: ctx.sessionID,
      questions: [
        {
          question: `Would you like to switch to the plan agent and create a plan saved to ${plan}?`,
          header: "Plan Mode",
          custom: false,
          options: [
            { label: "Yes", description: "Switch to plan agent for research and planning" },
            { label: "No", description: "Stay with build agent to continue making changes" },
          ],
        },
      ],
      tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
    })

    const answer = answers[0]?.[0]

    if (answer === "No") throw new Question.RejectedError()

    await SessionPrompt.deliver({
      sessionID: ctx.sessionID,
      parts: [
        {
          type: "text",
          text: "User has requested to enter plan mode. Switch to plan mode and begin planning.",
          synthetic: true,
          internal: true,
        },
      ],
      model: Provider.INHERIT,
      variant: Provider.INHERIT,
      params: { agent: "plan" },
      join: true,
      wake: false,
    })
    await Session.setAgent(ctx.sessionID, "plan")

    return {
      title: "Switching to plan agent",
      output: `User confirmed to switch to plan mode. A new message has been created to switch you to plan mode. The plan file will be at ${plan}. Begin planning.`,
      metadata: {},
    }
  },
})
