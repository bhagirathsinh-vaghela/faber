import { describe, expect, test } from "bun:test"
import { recovered, single } from "./dictation-recover"

describe("recovered", () => {
  test("a held transcript returns its text", () => {
    expect(recovered({ data: { text: "hello" }, response: { status: 200 } })).toBe("hello")
  })

  test("a 404 is terminal", () => {
    expect(recovered({ response: { status: 404 } })).toBe("gone")
  })

  test("a recovery still running is retried", () => {
    expect(() => recovered({ data: { pending: true }, response: { status: 202 } })).toThrow(
      "dictation recover answered 202",
    )
  })

  test("no response at all is retried", () => {
    expect(() => recovered({})).toThrow("dictation recover answered nothing")
  })
})

describe("single", () => {
  test("a call for the key in flight joins it; another key starts its own run", async () => {
    const flight = single()
    const runs: string[] = []
    const held = Promise.withResolvers<void>()
    const run = (key: string) => () => {
      runs.push(key)
      return key === "a" ? held.promise : Promise.resolve()
    }

    const first = flight("a", run("a"))
    const joined = flight("a", run("a"))
    await flight("b", run("b"))
    held.resolve()
    await first
    await flight("a", run("a"))

    expect(joined).toBe(first)
    expect(runs).toEqual(["a", "b", "a"])
  })

  test("an earlier key finishing does not end the run of the key now in flight", async () => {
    const flight = single()
    const runs: string[] = []
    const a = Promise.withResolvers<void>()
    const b = Promise.withResolvers<void>()

    const first = flight("a", () => (runs.push("a"), a.promise))
    const second = flight("b", () => (runs.push("b"), b.promise))
    a.resolve()
    await first
    const joined = flight("b", () => (runs.push("b"), b.promise))
    b.resolve()
    await second

    expect(joined).toBe(second)
    expect(runs).toEqual(["a", "b"])
  })
})
