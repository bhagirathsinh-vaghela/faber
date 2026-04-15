import z from "zod"
import { Tool } from "./tool"
import { Question } from "../question"
import DESCRIPTION from "./question.txt"

export const QuestionTool = Tool.define("question", {
  description: DESCRIPTION,
  parameters: z.object({
    questions: z.array(Question.Info.omit({ custom: true })).describe("Questions to ask"),
  }).strict(),
  async execute(params, ctx) {
    const answers = await Question.ask({
      sessionID: ctx.sessionID,
      questions: params.questions,
      tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
    })

    const allDeferred = answers.every((a) => a.length === 1 && a[0] === Question.DEFERRED_ANSWER[0])
    if (allDeferred) {
      return {
        title: "Question deferred",
        output: "The user deferred this question and will not answer right now. Continue without this answer. You may re-ask later if you still need it.",
        metadata: { answers, deferred: true },
      }
    }

    function format(answer: Question.Answer | undefined) {
      if (!answer?.length) return "Unanswered"
      if (answer.length === 1 && answer[0] === Question.DEFERRED_ANSWER[0]) return "Deferred"
      return answer.join(", ")
    }

    const formatted = params.questions.map((q, i) => `"${q.question}"="${format(answers[i])}"`).join(", ")

    return {
      title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
      output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
      metadata: { answers, deferred: false },
    }
  },
})
