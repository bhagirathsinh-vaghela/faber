import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION_WRITE from "./todowrite.txt"
import { Todo } from "../session/todo"

export const TodoWriteTool = Tool.define("todowrite", {
  description: DESCRIPTION_WRITE,
  parameters: z
    .object({
      todos: z.array(z.object(Todo.Info.shape)).describe("The updated todo list"),
    })
    .strict(),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "todowrite",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    const previous = await Todo.get(ctx.sessionID)
    const previousCompleted = new Set(previous.filter((t) => t.status === "completed").map((t) => t.id))
    const newlyCompleted = params.todos.filter((t) => t.status === "completed" && !previousCompleted.has(t.id))

    await Todo.update({
      sessionID: ctx.sessionID,
      todos: params.todos,
    })

    let output = JSON.stringify(params.todos, null, 2)
    if (newlyCompleted.length >= 3) {
      const hasVerify = params.todos.some(
        (t) => t.content.toLowerCase().includes("verif") || t.content.toLowerCase().includes("test"),
      )
      if (!hasVerify) {
        output += "\n\nNote: several tasks were just marked done. Before moving on, confirm the changes work: run the relevant tests or build, and check the output for errors."
      }
    }

    return {
      title: `${params.todos.filter((x) => x.status !== "completed").length} todos`,
      output,
      metadata: {
        todos: params.todos,
      },
    }
  },
})

export const TodoReadTool = Tool.define("todoread", {
  description: "Use this tool to read your todo list",
  parameters: z.object({}),
  async execute(_params, ctx) {
    await ctx.ask({
      permission: "todoread",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    const todos = await Todo.get(ctx.sessionID)
    return {
      title: `${todos.filter((x) => x.status !== "completed").length} todos`,
      metadata: {
        todos,
      },
      output: JSON.stringify(todos, null, 2),
    }
  },
})
