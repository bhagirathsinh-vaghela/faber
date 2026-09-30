import type { Message, Part, TextPart, ToolPart, UserMessage } from "@opencode-ai/sdk/v2"

// Once a question is answered or goes unanswered, the server writes it down:
// its tool part becomes a
// text part holding the question, and the answer a user message. Both carry
// `question`, so the transcript draws the card the tool part drew, and the
// answer's message folds into the turn that asked.

// The user message holding a question's answer: part of the turn that asked,
// never a turn of its own.
export function reply(parts: Part[] | undefined) {
  return !!parts?.some((p) => p.type === "text" && !!p.question)
}

// Cached per part, so a card does not remount every time its list is re-read.
const drawn = new WeakMap<TextPart, ToolPart>()

// The part to draw: a written-down question as the tool part it replaced,
// anything else as itself.
export function shown(part: Part): Part {
  if (part.type !== "text" || !part.question) return part
  const cached = drawn.get(part)
  if (cached) return cached
  const record = part.question
  const input = { questions: record.questions }
  const time = { start: part.time?.start ?? 0, end: part.time?.end ?? 0 }
  const tool: ToolPart = {
    id: part.id,
    sessionID: part.sessionID,
    messageID: part.messageID,
    type: "tool",
    callID: record.callID,
    tool: "question",
    // An unanswered one draws the tool's own error card: the tool's dismissal
    // error for a dismissal, the processor's abort error for any other end.
    state: record.answers
      ? { status: "completed", input, output: "", title: "", metadata: { answers: record.answers }, time }
      : {
          status: "error",
          input,
          error:
            record.error === "the user dismissed it" ? "Error: The user dismissed this question" : "Tool execution aborted",
          time,
        },
  }
  drawn.set(part, tool)
  return tool
}

// The user message a step's turn began with: the step's parent, or the
// message before it when the parent is a question's answer.
export function opener(messages: Message[], parts: Record<string, Part[] | undefined>, parentID: string) {
  const at = messages.findIndex((m) => m.id === parentID)
  return at < 0
    ? undefined
    : messages.findLast((m, i): m is UserMessage => i <= at && m.role === "user" && !reply(parts[m.id]))
}
