import { describe, expect, test } from "bun:test"
import type { Message, Part, TextPart } from "@opencode-ai/sdk/v2"
import { opener, reply, shown } from "./question"

const questions = [{ question: "Which one?", header: "Pick", options: [{ label: "A", description: "first" }] }]

function written(record: Partial<NonNullable<TextPart["question"]>>): TextPart {
  return {
    id: "p1",
    sessionID: "s1",
    messageID: "m1",
    type: "text",
    text: "[Record of a question tool call, stored as text. To ask a new question, call the question tool.]\nAsked: Which one?\nOffered: A",
    synthetic: true,
    question: { callID: "toolu_q", questions, ...record },
  }
}

describe("a written-down question draws as the tool card it replaced", () => {
  test("an answered one is a completed question call carrying its answers", () => {
    expect(shown(written({ answers: [["A"]] }))).toEqual({
      id: "p1",
      sessionID: "s1",
      messageID: "m1",
      type: "tool",
      callID: "toolu_q",
      tool: "question",
      state: {
        status: "completed",
        input: { questions },
        output: "",
        title: "",
        metadata: { answers: [["A"]] },
        time: { start: 0, end: 0 },
      },
    })
  })

  // An unanswered question draws the tool's own error card: a dismissal carries
  // the tool's dismissal error, any other end the processor's abort error.
  const unanswered: [string, string][] = [
    ["the user dismissed it", "Error: The user dismissed this question"],
    ["the turn was stopped", "Tool execution aborted"],
    ["the turn was cut off", "Tool execution aborted"],
    ["the server restarted", "Tool execution aborted"],
  ]
  for (const [reason, error] of unanswered)
    test(`an unanswered one (${reason}) is the failed call it drew before`, () => {
      expect(shown(written({ error: reason }))).toEqual({
        id: "p1",
        sessionID: "s1",
        messageID: "m1",
        type: "tool",
        callID: "toolu_q",
        tool: "question",
        state: { status: "error", input: { questions }, error, time: { start: 0, end: 0 } },
      })
    })

  test("the same part draws as the same object, so its card is not remounted", () => {
    const part = written({ answers: [["A"]] })
    expect(shown(part)).toBe(shown(part))
  })

  test("any other part is drawn as itself", () => {
    const plain: TextPart = { id: "p2", sessionID: "s1", messageID: "m1", type: "text", text: "hi" }
    expect(shown(plain)).toBe(plain)
  })
})

describe("reply", () => {
  test("a message holding an answer is a reply; a typed one is not", () => {
    const answer: Part[] = [{ ...written({ answers: [["A"]] }), text: "A", synthetic: undefined }]
    expect(reply(answer)).toBe(true)
    expect(reply([{ id: "p3", sessionID: "s1", messageID: "m2", type: "text", text: "go" }])).toBe(false)
    expect(reply(undefined)).toBe(false)
  })
})

describe("opener: the user message a step's turn began with", () => {
  const user = (id: string) =>
    ({ id, sessionID: "s1", role: "user", time: { created: 1 }, agent: "build", model: { providerID: "p", modelID: "m" } }) as Message
  const step = (id: string, parentID: string) => ({ id, sessionID: "s1", role: "assistant", parentID }) as Message
  const typed = (id: string): Part[] => [{ id: `${id}-p`, sessionID: "s1", messageID: id, type: "text", text: "go" }]
  const messages = [user("u1"), step("a1", "u1"), user("r1"), step("a2", "r1"), user("u2"), step("a3", "u2")]
  const parts: Record<string, Part[]> = {
    u1: typed("u1"),
    r1: [{ ...written({ answers: [["A"]] }), id: "r1-p", messageID: "r1", text: "A", synthetic: undefined }],
    u2: typed("u2"),
  }
  const cases: [string, string, string | undefined][] = [
    ["a step parented to the turn's opener", "u1", "u1"],
    ["a step parented to an answer", "r1", "u1"],
    ["a step parented to a typed message later in the turn", "u2", "u2"],
    ["a parent that is not loaded", "u9", undefined],
  ]
  for (const [name, parentID, expected] of cases)
    test(name, () => expect(opener(messages, parts, parentID)?.id).toBe(expected))
})
