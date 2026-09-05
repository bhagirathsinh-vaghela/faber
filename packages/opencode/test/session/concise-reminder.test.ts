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

// The reminder rides the typed prompt that opens a turn, and ONLY there. It is
// due when the newest message is a fresh typed prompt without the reminder yet
// — so it attaches once, to a message not yet on the wire. It never fires
// mid-turn (which would append to a message already sent and re-hash the
// prefix), and never onto a synthetic message.
describe("conciseDue", () => {
  test("a fresh typed prompt with no reminder is due", () => {
    const prompt = user({ texts: [{ text: "start" }] })
    expect(SessionPrompt.conciseDue([prompt])).toBe(true)
  })

  test("the same prompt is not due once it carries the reminder", () => {
    const prompt = user({ texts: [{ text: "start" }, reminder] })
    expect(SessionPrompt.conciseDue([prompt])).toBe(false)
  })

  test("mid-turn, behind an assistant message, is never due", () => {
    const prompt = user({ texts: [{ text: "start" }, reminder] })
    const msgs = [prompt, assistant(), assistant(), assistant(), assistant(), assistant()]
    expect(SessionPrompt.conciseDue(msgs)).toBe(false)
  })

  test("a new typed prompt after a reminded turn is due again", () => {
    const first = user({ texts: [{ text: "turn one" }, reminder] })
    const second = user({ texts: [{ text: "turn two" }] })
    expect(SessionPrompt.conciseDue([first, assistant(), second])).toBe(true)
  })

  test("a synthetic user message at the tail is never due", () => {
    const prompt = user({ texts: [{ text: "start" }, reminder] })
    const delivered = user({ synthetic: true, texts: [{ text: "job result", synthetic: true }] })
    expect(SessionPrompt.conciseDue([prompt, assistant(), delivered])).toBe(false)
  })

  test("a fresh typed prompt is due even after a reminded prior turn", () => {
    const prompt = user({ texts: [{ text: "subtask work" }] })
    expect(SessionPrompt.conciseDue([prompt])).toBe(true)
  })
})
