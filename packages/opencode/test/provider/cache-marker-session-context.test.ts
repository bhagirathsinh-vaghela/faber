import { describe, expect, test } from "bun:test"
import { ProviderTransform } from "../../src/provider/transform"
import { SESSION_CONTEXT_MARKER, SystemPrompt } from "../../src/session/system"
import type { ModelMessage } from "ai"

function system(text: string): ModelMessage {
  return { role: "system", content: text }
}

function prompt(text: string): ModelMessage {
  return { role: "user", content: [{ type: "text" as const, text }] }
}

function reply(text: string): ModelMessage {
  return { role: "assistant", content: [{ type: "text" as const, text }] }
}

const CONTEXT = `${SESSION_CONTEXT_MARKER}\n  Current date: 2026-08-26\n  Current git branch: main\n</session_context>`

// The 1h markers must land on the blocks that stay byte-identical for a
// directory. The session-context block holds the current date and branch, so a
// marker there would key an entry that dies at the next midnight or checkout.
describe("cache markers with a session-context system block", () => {
  test("the 1h markers stay on the preamble and env blocks", () => {
    const withContext = [system("preamble"), system("S1"), system("S2"), system(CONTEXT), prompt("do the thing")]

    expect(ProviderTransform.cacheMarkerIndices(withContext)).toEqual([1, 2, 4])
  })

  test("the same markers are chosen with and without the block", () => {
    const plain = [system("preamble"), system("S1"), system("S2"), prompt("do the thing")]
    const withContext = [system("preamble"), system("S1"), system("S2"), system(CONTEXT), prompt("do the thing")]

    const shifted = ProviderTransform.cacheMarkerIndices(withContext).map((index) => (index >= 3 ? index - 1 : index))
    expect(shifted).toEqual(ProviderTransform.cacheMarkerIndices(plain))
  })

  test("the conversation markers are unaffected mid-conversation", () => {
    const msgs = [
      system("preamble"),
      system("S1"),
      system("S2"),
      system(CONTEXT),
      prompt("turn one"),
      reply("done"),
      prompt("turn two"),
    ]

    expect(ProviderTransform.cacheMarkerIndices(msgs)).toEqual([1, 2, 5, 6])
  })

  test("a session with fewer system blocks than markers still marks what it has", () => {
    const msgs = [system("S1"), system(CONTEXT), prompt("do the thing")]

    expect(ProviderTransform.cacheMarkerIndices(msgs)).toEqual([0, 2])
  })

  test("a marker stays off the block when session content follows the context", () => {
    const composed = SystemPrompt.sessionBlock({ context: CONTEXT, question: "# Asking the user" })!
    const msgs = [system("preamble"), system("S1"), system("S2"), system(composed), prompt("do the thing")]

    expect(ProviderTransform.cacheMarkerIndices(msgs)).toEqual([1, 2, 4])
  })

  test("session content with no context block is still tagged", () => {
    const composed = SystemPrompt.sessionBlock({ question: "# Asking the user" })!
    const msgs = [system("preamble"), system("S1"), system("S2"), system(composed), prompt("do the thing")]

    expect(composed.startsWith(SESSION_CONTEXT_MARKER)).toBe(true)
    expect(ProviderTransform.cacheMarkerIndices(msgs)).toEqual([1, 2, 4])
  })

  test("no session content produces no block", () => {
    expect(SystemPrompt.sessionBlock({})).toBeUndefined()
  })
})
