import { describe, expect, test } from "bun:test"
import { SessionSummary } from "../../src/session/summary"
import type { MessageV2 } from "../../src/session/message-v2"

// A question's answer is a user message, and the loop parents the steps after
// it to that message; the turn's diff must still span the whole turn.
function user(id: string, answer = false) {
  const part = answer
    ? { type: "text", text: "A", question: { callID: "c", questions: [], answers: [["A"]] } }
    : { type: "text", text: "do it" }
  return { info: { id, role: "user" }, parts: [part] } as unknown as MessageV2.WithParts
}

function assistant(id: string, parentID: string) {
  return { info: { id, role: "assistant", parentID }, parts: [] } as unknown as MessageV2.WithParts
}

const all = [
  user("m1"),
  assistant("m2", "m1"),
  user("m3", true),
  assistant("m4", "m3"),
  user("m5", true),
  assistant("m6", "m5"),
  user("m7"),
  assistant("m8", "m7"),
]

const ids = (messageID: string) => SessionSummary.turn(all, messageID).map((m) => m.info.id)

describe("SessionSummary.turn", () => {
  test("an opener's turn spans every answer after it and the steps parented to them", () => {
    expect(ids("m1")).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"])
  })

  test("an answer resolves to the turn that asked", () => {
    expect(ids("m3")).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"])
    expect(ids("m5")).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"])
  })

  test("a typed message opens its own turn", () => {
    expect(ids("m7")).toEqual(["m7", "m8"])
  })

  test("a message that is not in the list has no turn", () => {
    expect(ids("m9")).toEqual([])
  })
})

describe("SessionSummary.summarize", () => {
  test("a message the session no longer has is skipped, not a crash", async () => {
    const { Instance } = await import("../../src/project/instance")
    const { Session } = await import("../../src/session")
    const { tmpdir } = await import("../fixture/fixture")
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "summarize a removed message" })
        await expect(
          SessionSummary.summarize({ sessionID: session.id, messageID: "msg_gone" }),
        ).resolves.toBeUndefined()
        await Session.remove(session.id)
      },
    })
  })

  test("a session removed before the summary runs is skipped, not a rejection", async () => {
    const { Instance } = await import("../../src/project/instance")
    const { Session } = await import("../../src/session")
    const { tmpdir } = await import("../fixture/fixture")
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "summarize a removed session" })
        await Session.remove(session.id)
        await expect(
          SessionSummary.summarize({ sessionID: session.id, messageID: "msg_gone" }),
        ).resolves.toBeUndefined()
      },
    })
  })
})
