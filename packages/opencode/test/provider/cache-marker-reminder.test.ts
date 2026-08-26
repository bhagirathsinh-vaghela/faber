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

// M3 anchors the turn, and selectCacheMarkers skips a user message whose
// content is nothing but a <system-reminder>. A reminder appended beside the
// text the user typed has to leave that anchor where it was, or the turn's
// whole prefix falls outside the 20-block lookback.
describe("cache markers with an appended concise reminder", () => {
  test("a prompt carrying the reminder still anchors a marker", () => {
    const plain = [system("S1"), system("S2"), prompt(["do the thing"])]
    const withReminder = [system("S1"), system("S2"), prompt(["do the thing", REMINDER])]

    expect(ProviderTransform.cacheMarkerIndices(withReminder)).toEqual(
      ProviderTransform.cacheMarkerIndices(plain),
    )
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

  // A reminder-only message is skipped as meta, so the anchor falls back to the
  // last message carrying typed text instead of moving onto the reminder.
  test("a message of nothing but a reminder anchors on the prompt behind it", () => {
    const stranded = [system("S1"), system("S2"), prompt(["turn one"]), reply("done"), prompt([REMINDER])]

    expect(ProviderTransform.cacheMarkerIndices(stranded)).toEqual([0, 1, 2, 4])
  })
})
