import { describe, expect, test } from "bun:test"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { Log } from "../../src/util/log"

Log.init({ print: false })

const REVIEW = "review-skill"

function user(input: { synthetic?: boolean; texts?: { text: string; synthetic?: boolean }[] } = {}) {
  const id = Identifier.ascending("message")
  const textParts = (input.texts ?? [{ text: "go" }]).map((part) => ({
    id: Identifier.ascending("part"),
    messageID: id,
    sessionID: "ses_test",
    type: "text" as const,
    text: part.text,
    ...(part.synthetic ? { synthetic: true } : {}),
  }))
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
    parts: textParts as MessageV2.Part[],
  }
}

function assistant(
  input: {
    tools?: { tool: string; input?: any; status?: "running" | "error" }[]
    text?: string
    summary?: boolean
  } = {},
) {
  const id = Identifier.ascending("message")
  const toolParts = (input.tools ?? []).map((t) => ({
    id: Identifier.ascending("part"),
    messageID: id,
    sessionID: "ses_test",
    callID: Identifier.ascending("part"),
    type: "tool" as const,
    tool: t.tool,
    state: t.status
      ? { status: t.status, input: t.input ?? {}, error: "failed", time: { start: 0, end: 0 } }
      : {
          status: "completed" as const,
          input: t.input ?? {},
          output: "",
          title: "",
          metadata: {},
          time: { start: 0, end: 0 },
        },
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

const commit = (command = "git commit -m x", status?: "error") => ({ tool: "bash", input: { command }, status })

describe("skillLedger", () => {
  test("counts turns and commits after the skill-load anchor, the opener excluded", () => {
    const msgs = [
      assistant({ tools: [commit()] }),
      user({}),
      assistant({ tools: [{ tool: "skill", input: { name: REVIEW } }] }),
      user({}),
      assistant({ tools: [commit()] }),
      user({ synthetic: true, texts: [{ text: "job result", synthetic: true }] }),
      assistant(),
      user({}), // opener
    ]
    expect(SessionPrompt.skillLedger(msgs, REVIEW)).toEqual({ scope: "since load", turns: 2, commits: 1 })
  })

  test("a completed git commit counts; a git log and a failed commit do not", () => {
    const msgs = [
      assistant({ tools: [{ tool: "skill", input: { name: REVIEW } }] }),
      user({}),
      assistant({ tools: [commit(), commit("git log -1"), commit("git commit -m y", "error")] }),
      user({}),
    ]
    expect(SessionPrompt.skillLedger(msgs, REVIEW).commits).toBe(1)
  })

  test("no anchor found (post-compaction): scope reads since compaction, counts from the start", () => {
    const msgs = [assistant({ tools: [commit()] }), user({}), assistant(), user({})]
    expect(SessionPrompt.skillLedger(msgs, REVIEW)).toEqual({ scope: "since compaction", turns: 1, commits: 1 })
  })

  test("the window starts at the newest load's own part, and a failed load does not restart it", () => {
    const msgs = [
      assistant({ tools: [{ tool: "skill", input: { name: REVIEW } }] }),
      user({}),
      assistant({ tools: [commit(), { tool: "skill", input: { name: REVIEW } }, commit()] }),
      user({}),
      assistant({ tools: [commit(), { tool: "skill", input: { name: REVIEW }, status: "error" }] }),
      user({}),
    ]
    expect(SessionPrompt.skillLedger(msgs, REVIEW)).toEqual({ scope: "since load", turns: 1, commits: 2 })
  })
})

const EXIT = "LOOP-OVER:"

describe("skillExitRequested", () => {
  test("newest assistant text starting a line with the declared exit is true", () => {
    const msgs = [user({}), assistant({ text: "All done.\nLOOP-OVER: 2 rounds, last clean" })]
    expect(SessionPrompt.skillExitRequested(msgs, EXIT)).toBe(true)
  })

  test("a line carrying another skill's exit does not count", () => {
    const msgs = [user({}), assistant({ text: "All done.\nSKILL-DONE: 2 rounds, last clean" })]
    expect(SessionPrompt.skillExitRequested(msgs, EXIT)).toBe(false)
  })

  test("the exit mid-line does not count", () => {
    const msgs = [user({}), assistant({ text: "I will write LOOP-OVER: later" })]
    expect(SessionPrompt.skillExitRequested(msgs, EXIT)).toBe(false)
  })

  test("the line inside an OLDER assistant message does not count", () => {
    const msgs = [
      assistant({ text: "LOOP-OVER: 1 rounds, last clean" }),
      user({}),
      assistant({ text: "still working" }),
    ]
    expect(SessionPrompt.skillExitRequested(msgs, EXIT)).toBe(false)
  })

  test("no assistant message at all is false", () => {
    expect(SessionPrompt.skillExitRequested([user({})], EXIT)).toBe(false)
  })
})

describe("skillSection", () => {
  const body = "# Skill\n\nIntro.\n\n## Steps\n\nline one\nline two\n\n## Phase 0\n\nmore text"

  test("extracts between the declared heading and the next heading", () => {
    expect(SessionPrompt.skillSection(body, "Steps")).toBe("## Steps\n\nline one\nline two")
  })

  test("returns undefined when the heading is absent", () => {
    expect(SessionPrompt.skillSection("# Skill\n\nno steps here", "Steps")).toBeUndefined()
    expect(SessionPrompt.skillSection(body, "Checklist")).toBeUndefined()
  })

  test("runs to the end of the body when the heading is the last section", () => {
    const tail = "# Skill\n\n## Steps\n\nonly section"
    expect(SessionPrompt.skillSection(tail, "Steps")).toBe("## Steps\n\nonly section")
  })
})
