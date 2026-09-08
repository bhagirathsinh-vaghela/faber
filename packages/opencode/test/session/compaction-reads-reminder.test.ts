import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { Identifier } from "../../src/id/id"
import { Log } from "../../src/util/log"

Log.init({ print: false })

function user() {
  const id = Identifier.ascending("message")
  return { info: { id, sessionID: "ses_test", role: "user", time: { created: Date.now() } } as MessageV2.User, parts: [] }
}

function assistant(opts: { summary?: boolean; finish?: boolean } = {}) {
  const id = Identifier.ascending("message")
  return {
    info: {
      id,
      sessionID: "ses_test",
      role: "assistant",
      time: { created: Date.now() },
      ...(opts.summary ? { summary: true } : {}),
      // A completed turn (successful compaction included) carries a finish
      // reason; an errored/interrupted one does not.
      ...(opts.finish ? { finish: "stop" } : {}),
    } as MessageV2.Assistant,
    parts: [],
  }
}

// compactionReadsDue is true exactly on the first turn after a SUCCESSFUL
// compaction: the newest assistant before the turn opener is a finished summary.
describe("compactionReadsDue", () => {
  test("true when a finished summary assistant precedes the opener", () => {
    const messages = [user(), assistant({ summary: true, finish: true }), user()]
    expect(SessionPrompt.compactionReadsDue(messages)).toBe(true)
  })

  test("false when the preceding assistant is an ordinary (non-summary) turn", () => {
    const messages = [user(), assistant({ finish: true }), user()]
    expect(SessionPrompt.compactionReadsDue(messages)).toBe(false)
  })

  test("false a turn later, when an ordinary assistant sits between summary and opener", () => {
    const messages = [user(), assistant({ summary: true, finish: true }), user(), assistant({ finish: true }), user()]
    expect(SessionPrompt.compactionReadsDue(messages)).toBe(false)
  })

  test("false for an errored summary (summary set but no finish): reads were not dropped", () => {
    const messages = [user(), assistant({ summary: true }), user()]
    expect(SessionPrompt.compactionReadsDue(messages)).toBe(false)
  })

  test("false with no assistant before the opener", () => {
    expect(SessionPrompt.compactionReadsDue([user()])).toBe(false)
  })
})
