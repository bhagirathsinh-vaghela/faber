import { describe, expect, test } from "bun:test"
import { legacyInternal, typed } from "./internal"

// Ten parts in one existing store, across six sessions, carry an unflagged
// context update on the same message as a typed prompt. The transcript draws
// one part per message, so recognising them is what keeps those prompts on
// screen.
describe("legacyInternal", () => {
  test("recognises the blocks that land on a user's own message", () => {
    expect(legacyInternal({ text: "<session_context_update>\n  Current date is now: 2026-08-29\n" })).toBe(true)
    expect(legacyInternal({ text: "<project_subagents>\n  reviewer\n" })).toBe(true)
  })

  test("leaves a typed prompt alone, whatever it opens with", () => {
    expect(legacyInternal({ text: "Okay the second one is the one we picked" })).toBe(false)
    expect(legacyInternal({ text: "<div> is not one of the markers" })).toBe(false)
  })

  // A writer that marked a block deliberately is never second-guessed by its
  // text, in either direction.
  test("never overrides an explicit flag", () => {
    expect(legacyInternal({ text: "<session_context_update>", internal: false })).toBe(false)
    expect(legacyInternal({ text: "an ordinary prompt", internal: true })).toBe(false)
  })
})

// An attachment writes SEVERAL synthetic parts onto the user's own message: a
// tool echo, then the payload. A classifier that scans for a synthetic part it
// does not recognise walks past the echo it knows to the payload beside it, and
// the notice branch it reaches is tested before the user branch, so the payload
// is drawn INSTEAD of the prompt. Seven messages in one existing store already
// read that way, two of them ordinary complaints the user typed.
describe("typed", () => {
  test("a prompt with a file attachment still counts as typed", () => {
    expect(
      typed([
        { type: "text", text: "I see some weird UI issue." },
        { type: "text", synthetic: true, text: "Called the Read tool with the following input: …" },
        { type: "text", synthetic: true, text: "<file>\n 1488\t const commentNote = (\n</file>" },
      ]),
    ).toBe(true)
  })

  test("a prompt with a review comment still counts as typed", () => {
    expect(
      typed([
        { type: "text", text: "I don't care what you fixed." },
        { type: "text", synthetic: true, text: "The user commented on this diff in packages/app/src/x.tsx:" },
      ]),
    ).toBe(true)
  })

  test("a message with only synthetic parts is not typed", () => {
    expect(
      typed([{ type: "text", synthetic: true, text: "Pardon the interruption — the server needed a restart." }]),
    ).toBe(false)
  })

  test("whitespace is not typed text", () => {
    expect(typed([{ type: "text", text: "   \n  " }])).toBe(false)
  })

  test("a non-text part is not typed text", () => {
    expect(typed([{ type: "file" }])).toBe(false)
  })
})
