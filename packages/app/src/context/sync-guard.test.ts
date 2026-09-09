import { describe, expect, test } from "bun:test"
import { guardParts } from "./sync"
import type { Part, TextPart, ReasoningPart, ToolPart } from "@opencode-ai/sdk/v2/client"

const text = (id: string, body: string): TextPart => ({
  id,
  sessionID: "s1",
  messageID: "m1",
  type: "text",
  text: body,
})

const reasoning = (id: string, body: string): ReasoningPart => ({
  id,
  sessionID: "s1",
  messageID: "m1",
  type: "reasoning",
  text: body,
  time: { start: 0 },
})

const tool = (id: string): ToolPart => ({
  id,
  sessionID: "s1",
  messageID: "m1",
  type: "tool",
  callID: "c1",
  tool: "bash",
  state: { status: "pending", input: {}, raw: "" },
})

describe("guardParts — streaming text survives a stale REST snapshot", () => {
  test("held text part absent from snapshot is kept", () => {
    const held = [text("p1", "a".repeat(5000))]
    const snapshot: Part[] = []
    const merged = guardParts(snapshot, held, false)
    expect(merged).toEqual([text("p1", "a".repeat(5000))])
  })

  test("shorter snapshot text is rejected in favor of held", () => {
    const held = [text("p1", "a".repeat(5000))]
    const snapshot = [text("p1", "a".repeat(256))]
    const merged = guardParts(snapshot, held, false)
    expect(merged).toEqual([text("p1", "a".repeat(5000))])
  })

  test("longer snapshot text wins over held", () => {
    const held = [text("p1", "a".repeat(100))]
    const snapshot = [text("p1", "a".repeat(5000))]
    const merged = guardParts(snapshot, held, false)
    expect(merged).toEqual([text("p1", "a".repeat(5000))])
  })

  test("tool parts take the snapshot regardless of held state", () => {
    const heldTool = tool("t1")
    const snapshotTool: ToolPart = {
      ...tool("t1"),
      state: { status: "running", input: { cmd: "ls" }, time: { start: 1 } },
    }
    const merged = guardParts([snapshotTool], [heldTool], false)
    expect(merged).toEqual([snapshotTool])
  })

  test("completed message lets snapshot overwrite everything", () => {
    const held = [text("p1", "a".repeat(5000))]
    const snapshot = [text("p1", "short")]
    const merged = guardParts(snapshot, held, true)
    expect(merged).toEqual([text("p1", "short")])
  })

  test("no held parts returns snapshot unchanged", () => {
    const snapshot = [text("p1", "a"), text("p2", "b"), text("p3", "c")]
    expect(guardParts(snapshot, undefined, false)).toBe(snapshot)
    expect(guardParts(snapshot, [], false)).toBe(snapshot)
  })

  test("output is sorted by id when parts are merged", () => {
    const held = [text("p3", "a".repeat(100))]
    const snapshot = [text("p1", "x"), text("p2", "y")]
    const merged = guardParts(snapshot, held, false)
    expect(merged.map((p) => p.id)).toEqual(["p1", "p2", "p3"])
  })

  test("reasoning part gets the same protection as text", () => {
    const held = [reasoning("r1", "a".repeat(3000))]
    const snapshot: Part[] = []
    const merged = guardParts(snapshot, held, false)
    expect(merged).toEqual([reasoning("r1", "a".repeat(3000))])
  })

  test("mixed parts: text protected, tool and step-start from snapshot", () => {
    const heldText = text("p2", "a".repeat(5000))
    const snapshotTool = tool("p1")
    const snapshotStep: Part = {
      id: "p3",
      sessionID: "s1",
      messageID: "m1",
      type: "step-start",
    }
    const merged = guardParts([snapshotTool, snapshotStep], [heldText, snapshotTool], false)
    expect(merged.map((p) => p.id)).toEqual(["p1", "p2", "p3"])
    expect(merged[1]).toEqual(heldText)
  })
})
