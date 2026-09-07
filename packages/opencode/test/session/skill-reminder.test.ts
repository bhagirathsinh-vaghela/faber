import { describe, expect, test } from "bun:test"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { Log } from "../../src/util/log"

Log.init({ print: false })

const REVIEW = "review-skill"

function user(input: { synthetic?: boolean; texts?: { text: string; synthetic?: boolean }[]; review?: "completed" | "failed" }) {
  const id = Identifier.ascending("message")
  const textParts = (input.texts ?? [{ text: "go" }]).map((part) => ({
    id: Identifier.ascending("part"),
    messageID: id,
    sessionID: "ses_test",
    type: "text" as const,
    text: part.text,
    ...(part.synthetic ? { synthetic: true } : {}),
  }))
  const reviewPart = input.review
    ? [
        {
          id: Identifier.ascending("part"),
          messageID: id,
          sessionID: "ses_test",
          type: "text" as const,
          text: "<background-subagent-result>...",
          synthetic: true,
          backgroundSubagentResult: { subagentId: "a1", description: "review", status: input.review },
        },
      ]
    : []
  return {
    info: {
      id,
      sessionID: "ses_test",
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-opus-5" },
      ...(input.synthetic ? { synthetic: true } : {}),
    } as MessageV2.User,
    parts: [...textParts, ...reviewPart] as MessageV2.Part[],
  }
}

function assistant(input: { tools?: { tool: string; input?: any }[]; text?: string; summary?: boolean } = {}) {
  const id = Identifier.ascending("message")
  const toolParts = (input.tools ?? []).map((t) => ({
    id: Identifier.ascending("part"),
    messageID: id,
    sessionID: "ses_test",
    callID: Identifier.ascending("part"),
    type: "tool" as const,
    tool: t.tool,
    state: { status: "completed" as const, input: t.input ?? {}, output: "", title: "", metadata: {}, time: { start: 0, end: 0 } },
  }))
  const textPart = input.text
    ? [
        {
          id: Identifier.ascending("part"),
          messageID: id,
          sessionID: "ses_test",
          type: "text" as const,
          text: input.text,
        },
      ]
    : []
  return {
    info: {
      id,
      sessionID: "ses_test",
      parentID: Identifier.ascending("message"),
      role: "assistant",
      time: { created: Date.now(), completed: Date.now() },
      modelID: "claude-opus-5",
      providerID: "anthropic",
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...(input.summary ? { summary: true, finish: "stop" } : {}),
    } as MessageV2.Assistant,
    parts: [...toolParts, ...textPart] as MessageV2.Part[],
  }
}

describe("skillLedger", () => {
  test("counts edits, reviews, and commits after the skill-load anchor", () => {
    const msgs = [
      user({}),
      assistant({ tools: [{ tool: "skill", input: { name: REVIEW } }] }),
      user({}),
      assistant({ tools: [{ tool: "edit" }, { tool: "edit" }] }),
      user({ review: "completed" }),
    ]
    const led = SessionPrompt.skillLedger(msgs, REVIEW)
    expect(led.scope).toBe("since load")
    expect(led.edits).toBe(2)
    expect(led.reviews).toBe(1)
    expect(led.editsSinceReview).toBe(0)
  })

  test("edits before the anchor are not counted", () => {
    const msgs = [
      assistant({ tools: [{ tool: "edit" }] }),
      user({}),
      assistant({ tools: [{ tool: "skill", input: { name: REVIEW } }] }),
      user({}),
    ]
    const led = SessionPrompt.skillLedger(msgs, REVIEW)
    expect(led.edits).toBe(0)
  })

  test("editsSinceReview resets after a completed review, then accrues again", () => {
    const msgs = [
      assistant({ tools: [{ tool: "skill", input: { name: REVIEW } }] }),
      user({}),
      assistant({ tools: [{ tool: "edit" }] }),
      user({ review: "completed" }),
      assistant({ tools: [{ tool: "edit" }, { tool: "edit" }] }),
      user({}),
    ]
    const led = SessionPrompt.skillLedger(msgs, REVIEW)
    expect(led.edits).toBe(3)
    expect(led.editsSinceReview).toBe(2)
  })

  test("a failed review does not reset editsSinceReview", () => {
    const msgs = [
      assistant({ tools: [{ tool: "skill", input: { name: REVIEW } }] }),
      user({}),
      assistant({ tools: [{ tool: "edit" }] }),
      user({ review: "failed" }),
    ]
    const led = SessionPrompt.skillLedger(msgs, REVIEW)
    expect(led.reviews).toBe(0)
    expect(led.editsSinceReview).toBe(1)
  })

  test("no anchor found (post-compaction): scope reads since compaction, counts from the start", () => {
    const msgs = [assistant({ tools: [{ tool: "edit" }] }), user({})]
    const led = SessionPrompt.skillLedger(msgs, REVIEW)
    expect(led.scope).toBe("since compaction")
    expect(led.edits).toBe(1)
  })

  test("a git commit in a bash command counts; a git log does not", () => {
    const msgs = [
      assistant({ tools: [{ tool: "skill", input: { name: REVIEW } }] }),
      user({}),
      assistant({ tools: [{ tool: "bash", input: { command: "git commit -m x" } }, { tool: "bash", input: { command: "git log -1" } }] }),
      user({}),
    ]
    const led = SessionPrompt.skillLedger(msgs, REVIEW)
    expect(led.commits).toBe(1)
  })

  test("turns count both typed and synthetic user messages, excluding the opener", () => {
    const msgs = [
      assistant({ tools: [{ tool: "skill", input: { name: REVIEW } }] }),
      user({}),
      assistant(),
      user({ synthetic: true, texts: [{ text: "job result", synthetic: true }] }),
      assistant(),
      user({}), // opener
    ]
    const led = SessionPrompt.skillLedger(msgs, REVIEW)
    expect(led.turns).toBe(2)
  })
})

describe("skillExitRequested", () => {
  test("newest assistant text starting a line with SKILL-DONE: is true", () => {
    const msgs = [user({}), assistant({ text: "All done.\nSKILL-DONE: 2 rounds, last clean" })]
    expect(SessionPrompt.skillExitRequested(msgs)).toBe(true)
  })

  test("the line inside an OLDER assistant message does not count", () => {
    const msgs = [
      assistant({ text: "SKILL-DONE: 1 rounds, last clean" }),
      user({}),
      assistant({ text: "still working" }),
    ]
    expect(SessionPrompt.skillExitRequested(msgs)).toBe(false)
  })

  test("no assistant message at all is false", () => {
    expect(SessionPrompt.skillExitRequested([user({})])).toBe(false)
  })
})

describe("skillChecklistSection", () => {
  const body = "# Skill\n\nIntro.\n\n## Checklist\n\nline one\nline two\n\n## Phase 0\n\nmore text"

  test("extracts between the Checklist heading and the next heading", () => {
    expect(SessionPrompt.skillChecklistSection(body)).toBe("## Checklist\n\nline one\nline two")
  })

  test("returns undefined when the heading is absent", () => {
    expect(SessionPrompt.skillChecklistSection("# Skill\n\nno checklist here")).toBeUndefined()
  })

  test("runs to the end of the body when Checklist is the last section", () => {
    const tail = "# Skill\n\n## Checklist\n\nonly section"
    expect(SessionPrompt.skillChecklistSection(tail)).toBe("## Checklist\n\nonly section")
  })
})
