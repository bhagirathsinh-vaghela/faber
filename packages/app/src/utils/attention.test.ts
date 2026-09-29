import { describe, expect, test } from "bun:test"
import { AGENT_FALLBACK, attention, busy } from "./attention"
import { isAlive } from "@opencode-ai/util/session"

// The overview dot and the spinners elsewhere read the same facts through the
// same table. A dot that appears on a narrower condition than the spinner
// leaves a session looking idle in one place and working in another, and the
// two views disagree about a session the user is deciding whether to stop.
describe("attention — work that no turn is executing", () => {
  test("a running job shows a busy dot with no turn in flight", () => {
    const state = busy(attention({ turn: false, subagents: 0, jobs: 1 }))
    expect(state?.tint).toBe("var(--box-indicator-job)")
    expect(state?.overlays).toEqual([])
  })

  test("an open subagent shows a busy dot with no turn in flight", () => {
    const state = busy(attention({ turn: false, subagents: 2, jobs: 0 }))
    expect(state?.tint).toBe("var(--box-accent-subagent)")
    expect(state?.overlays).toEqual([])
  })

  test("an own turn alongside a job crossfades the job indicator over the agent", () => {
    const state = busy(attention({ turn: true, subagents: 0, jobs: 1, agent: "nonexistent-agent" }))
    expect(state?.tint).toBe(AGENT_FALLBACK)
    expect(state?.overlays).toEqual(["var(--box-indicator-job)"])
  })

  test("nothing running shows no busy dot", () => {
    expect(busy(attention({ turn: false, subagents: 0, jobs: 0 }))).toBeUndefined()
  })

  // The states that need an answer still outrank the ones that only report
  // what a session is doing, whatever is running underneath them.
  test("a question outranks a running job", () => {
    expect(attention({ turn: false, jobs: 1, question: true })?.kind).toBe("question")
  })
})

// isAlive governs SSE subscription scope and transcript eviction, so a session
// it calls dead loses the transcript its pending result would land in.
describe("isAlive — work the session waits on", () => {
  test("an own turn keeps a session live", () => {
    expect(isAlive({ turn: true, subagents: 0, jobs: 0 })).toBe(true)
  })

  test("an open subagent keeps a session live", () => {
    expect(isAlive({ turn: false, subagents: 1, jobs: 0 })).toBe(true)
  })

  test("a running job keeps a session live", () => {
    expect(isAlive({ turn: false, subagents: 0, jobs: 1 })).toBe(true)
  })

  test("an armed ping daemon still counts", () => {
    expect(isAlive({ turn: false, subagents: 0, jobs: 0, pingAt: Date.now() })).toBe(true)
  })

  test("a session with none of them is not live", () => {
    expect(isAlive({ turn: false, subagents: 0, jobs: 0 })).toBe(false)
  })
})
