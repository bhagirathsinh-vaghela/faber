import { describe, expect, test } from "bun:test"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { Log } from "../../src/util/log"

Log.init({ print: false })

const CONCISE_MARKER = "<!-- concise-reminder -->"

function user(input: { synthetic?: boolean; texts: { text: string; synthetic?: boolean }[] }) {
  const id = Identifier.ascending("message")
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
    parts: input.texts.map((part) => ({
      id: Identifier.ascending("part"),
      messageID: id,
      sessionID: "ses_test",
      type: "text" as const,
      text: part.text,
      ...(part.synthetic ? { synthetic: true } : {}),
    })) as MessageV2.Part[],
  }
}

function assistant() {
  const id = Identifier.ascending("message")
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
    } as MessageV2.Assistant,
    parts: [] as MessageV2.Part[],
  }
}

const reminder = { text: `${CONCISE_MARKER}\n<system-reminder>\nconcise\n</system-reminder>`, synthetic: true }

describe("hasConciseReminder", () => {
  test("a typed prompt carrying the reminder is detected", () => {
    const msg = user({ texts: [{ text: "do the thing" }, reminder] })
    expect(SessionPrompt.hasConciseReminder(msg)).toBe(true)
  })

  test("a typed prompt alone is not", () => {
    const msg = user({ texts: [{ text: "do the thing" }] })
    expect(SessionPrompt.hasConciseReminder(msg)).toBe(false)
  })

  test("the marker in text the user typed does not count", () => {
    const msg = user({ texts: [{ text: `talking about ${CONCISE_MARKER}` }] })
    expect(SessionPrompt.hasConciseReminder(msg)).toBe(false)
  })
})

describe("sinceLastPrompt", () => {
  test("the window opens at the newest typed prompt, not an earlier turn", () => {
    const first = user({ texts: [{ text: "turn one" }, reminder] })
    const second = user({ texts: [{ text: "turn two" }] })
    const window = SessionPrompt.sinceLastPrompt([first, assistant(), second])

    expect(window.length).toBe(1)
    expect(window.some(SessionPrompt.hasConciseReminder)).toBe(false)
  })

  // A task summary and a compaction each mint a synthetic user message
  // mid-turn. Scoping the window to the newest message alone would leave the
  // turn's own reminder outside it and inject a second copy per synthetic
  // message, rewriting the tail every time.
  test("a synthetic message minted mid-turn keeps the turn's reminder in scope", () => {
    const prompt = user({ texts: [{ text: "use a subtask" }, reminder] })
    const summary = user({
      synthetic: true,
      texts: [{ text: "Summarize the task tool output above.", synthetic: true }],
    })
    const window = SessionPrompt.sinceLastPrompt([prompt, assistant(), summary])

    expect(window.some(SessionPrompt.hasConciseReminder)).toBe(true)
  })

  test("two synthetic messages in one turn still see the reminder", () => {
    const prompt = user({ texts: [{ text: "use two subtasks" }, reminder] })
    const one = user({ synthetic: true, texts: [{ text: "summary one", synthetic: true }] })
    const two = user({ synthetic: true, texts: [{ text: "summary two", synthetic: true }] })

    expect(SessionPrompt.sinceLastPrompt([prompt, one, two]).some(SessionPrompt.hasConciseReminder)).toBe(true)
  })

  test("history with no typed prompt yields every message", () => {
    const only = user({ synthetic: true, texts: [{ text: "resume", synthetic: true }] })
    expect(SessionPrompt.sinceLastPrompt([only]).length).toBe(1)
  })
})
