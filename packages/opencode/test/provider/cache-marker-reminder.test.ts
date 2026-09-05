import { describe, expect, test } from "bun:test"
import { ProviderTransform } from "../../src/provider/transform"
import type { ModelMessage } from "ai"

const REMINDER = "<system-reminder>\nKeep replies concise: lead with the answer.\n</system-reminder>"

function system(text: string): ModelMessage {
  return { role: "system", content: text }
}

function prompt(parts: string[]): ModelMessage {
  return { role: "user", content: parts.map((text) => ({ type: "text" as const, text })) }
}

function reply(text: string): ModelMessage {
  return { role: "assistant", content: [{ type: "text" as const, text }] }
}

// The reminder rides the typed prompt as a synthetic block. Once a block is on
// the wire it is byte-stable, so its position never breaks the cache; markers
// go on the last block whatever it is, with no special-casing for reminders.
describe("cache markers with an appended concise reminder", () => {
  test("a prompt carrying the reminder still anchors a marker", () => {
    const plain = [system("S1"), system("S2"), prompt(["do the thing"])]
    const withReminder = [system("S1"), system("S2"), prompt(["do the thing", REMINDER])]

    expect(ProviderTransform.cacheMarkerIndices(withReminder)).toEqual(ProviderTransform.cacheMarkerIndices(plain))
  })

  test("the reminder does not shift markers mid-conversation", () => {
    const withReminder = [
      system("S1"),
      system("S2"),
      prompt(["turn one"]),
      reply("done"),
      prompt(["turn two", REMINDER]),
    ]

    expect(ProviderTransform.cacheMarkerIndices(withReminder)).toEqual([0, 1, 3, 4])
  })
})
