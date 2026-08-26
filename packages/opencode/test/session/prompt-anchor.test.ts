import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { Identifier } from "../../src/id/id"
import { Log } from "../../src/util/log"
import type { Provider } from "../../src/provider/provider"

Log.init({ print: false })

const CONCISE_MARKER = "<!-- concise-reminder -->"
const model = { providerID: "anthropic", id: "claude-opus-5" } as Provider.Model

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

function texts(msg: MessageV2.WithParts) {
  const [converted] = MessageV2.toModelMessages([msg], model).messages
  return (converted.content as { type: string; text?: string }[])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
}

const reminder = { text: `${CONCISE_MARKER}\nconcise`, synthetic: true }

// The Anthropic SDK lowers a message-level cache marker onto the message's LAST
// block, so the turn's anchor is whatever is emitted last. It has to be the text
// the user typed: a synthetic block appended mid-turn would otherwise take the
// anchor and move it again on every append.
describe("typed text anchors the message", () => {
  test("a reminder minted after the prompt is emitted before it", () => {
    expect(texts(user({ texts: [{ text: "fix the bug" }, reminder] }))).toEqual([reminder.text, "fix the bug"])
  })

  test("many reminders all precede the prompt", () => {
    const msg = user({ texts: [{ text: "fix the bug" }, reminder, { text: "second", synthetic: true }] })
    expect(texts(msg).at(-1)).toBe("fix the bug")
  })

  test("a message of only synthetic blocks keeps their order", () => {
    const msg = user({ synthetic: true, texts: [{ text: "resume", synthetic: true }, reminder] })
    expect(texts(msg)).toEqual(["resume", reminder.text])
  })

  test("several typed blocks keep their relative order at the end", () => {
    const msg = user({ texts: [{ text: "first" }, reminder, { text: "second" }] })
    expect(texts(msg)).toEqual([reminder.text, "first", "second"])
  })

  // Anthropic recovers a changed prefix by walking back at most 20 blocks from a
  // marker, so the synthetic blocks a turn can stack ahead of the anchor must
  // stay well under 20 or a change recovers as a full rewrite. Today's injectors
  // cap out near six; this pins that the anchor survives a stack far larger than
  // the realistic max, and fails loud only if the serialization itself regresses.
  test("the typed anchor stays last under a large synthetic stack", () => {
    const stack = Array.from({ length: 19 }, (_, i) => ({ text: `${CONCISE_MARKER}\ns${i}`, synthetic: true }))
    const msg = user({ texts: [{ text: "the real prompt" }, ...stack] })
    const emitted = texts(msg)

    expect(emitted).toHaveLength(20)
    expect(emitted.at(-1)).toBe("the real prompt")
  })
})

// The guard reads the append target directly, on top of the turn window, so a
// reminder already on that message is seen regardless of how the window slices.
describe("reminder dedup reads the append target directly", () => {
  test("a reminder on a synthetic append target is detected on the message", () => {
    const resume = user({ synthetic: true, texts: [{ text: "Pardon the interruption", synthetic: true }, reminder] })
    expect(SessionPrompt.hasConciseReminder(resume)).toBe(true)
  })

  test("a message carrying only typed text is not seen as carrying a reminder", () => {
    const typed = user({ texts: [{ text: "an earlier real prompt" }] })
    expect(SessionPrompt.hasConciseReminder(typed)).toBe(false)
  })
})
