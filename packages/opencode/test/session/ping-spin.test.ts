import { describe, expect, test } from "bun:test"
import { SessionPing } from "../../src/session/ping"
import { Log } from "../../src/util/log"

Log.init({ print: false })

describe("SessionPing.pause", () => {
  // The anchor only moves when a request is DISPATCHED, so a ping that returns
  // without dispatching gets the same already-due deadline back on the next
  // pass. Sleeping that verbatim is a spin: the loop rebuilds the whole session
  // history back-to-back at full CPU until the TTL lapses.
  test("a due ping still yields a non-zero wait", () => {
    expect(SessionPing.pause({ type: "ping", delay: 0, at: Date.now() })).toBe(1000)
  })

  test("a ping further out keeps its own schedule", () => {
    expect(SessionPing.pause({ type: "ping", delay: 240_000, at: Date.now() })).toBe(240_000)
  })

  test("a delay under the floor is raised to it", () => {
    expect(SessionPing.pause({ type: "ping", delay: 12, at: Date.now() })).toBe(1000)
  })

  test("idle waits the idle tick", () => {
    expect(SessionPing.pause({ type: "idle" })).toBe(10_000)
  })

  test("no decision ever waits zero", () => {
    const decisions = [
      { type: "ping" as const, delay: 0, at: 0 },
      { type: "ping" as const, delay: -50, at: 0 },
      { type: "idle" as const },
      { type: "stop" as const },
    ]
    for (const next of decisions) expect(SessionPing.pause(next)).toBeGreaterThan(0)
  })
})
