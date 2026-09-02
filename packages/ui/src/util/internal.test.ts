import { describe, expect, test } from "bun:test"
import { legacyInternal } from "./internal"

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
