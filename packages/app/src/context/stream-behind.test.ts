import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2/client"
import { behind } from "./global-sync"

const text = (body: string, end?: number) =>
  ({ id: "p", sessionID: "s", messageID: "m", type: "text", text: body, time: { start: 1, end } }) as Part

describe("behind", () => {
  test("a shorter mid-stream snapshot is behind the deltas already held", () => {
    expect(behind(text("Hel"), text("Hello"))).toBe(true)
  })

  test("the finished part wins even when completion trimmed it shorter", () => {
    expect(behind(text("Hello", 2), text("Hello  \n"))).toBe(false)
  })

  test("a snapshot at least as long as the held text is taken", () => {
    expect(behind(text("Hello"), text("Hello"))).toBe(false)
  })
})
