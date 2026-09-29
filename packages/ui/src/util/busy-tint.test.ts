import { describe, expect, test } from "bun:test"
import { busyBase, busyDelay, busyOverlays, busyShown, busyTints } from "./busy-tint"

const AGENT = "#agent"

describe("busy tints", () => {
  test("own turn alone: agent colour, no overlay", () => {
    const facts = { turn: true, subagents: 0, jobs: 0 }
    expect(busyTints(facts, AGENT)).toEqual([AGENT])
    expect(busyBase(facts, AGENT)).toBe(AGENT)
    expect(busyOverlays(facts, AGENT)).toEqual([])
  })

  test("own turn + subagent: subagent accent crossfades over the agent base", () => {
    const facts = { turn: true, subagents: 1, jobs: 0 }
    expect(busyBase(facts, AGENT)).toBe(AGENT)
    expect(busyOverlays(facts, AGENT)).toEqual(["var(--box-accent-subagent)"])
    // A single overlay sits at the half-cycle, which is what a two-colour
    // cross-fade holds.
    expect(busyDelay(0, 1)).toBe("-1.30s")
  })

  test("several subagents contribute one colour, not one each", () => {
    const facts = { turn: false, subagents: 3, jobs: 0 }
    expect(busyTints(facts, AGENT)).toEqual(["var(--box-accent-subagent)"])
  })

  test("no agent colour resolved: base falls back to the interactive tint", () => {
    const facts = { turn: true, subagents: 0, jobs: 0 }
    expect(busyBase(facts, undefined)).toBe("var(--icon-interactive-base)")
  })

  test("idle: the base still resolves to a colour", () => {
    const facts = { turn: false, subagents: 0, jobs: 0 }
    expect(busyTints(facts, AGENT)).toEqual([])
    expect(busyBase(facts, AGENT)).toBe("var(--box-accent-subagent)")
    expect(busyOverlays(facts, AGENT)).toEqual([])
  })
})

describe("busy tints — a running job", () => {
  test("a job alone: the job indicator colour is the base", () => {
    const facts = { turn: false, subagents: 0, jobs: 1 }
    expect(busyBase(facts, AGENT)).toBe("var(--box-indicator-job)")
    expect(busyOverlays(facts, AGENT)).toEqual([])
  })

  test("own turn + job: the job indicator crossfades over the agent base", () => {
    const facts = { turn: true, subagents: 0, jobs: 2 }
    expect(busyBase(facts, AGENT)).toBe(AGENT)
    expect(busyOverlays(facts, AGENT)).toEqual(["var(--box-indicator-job)"])
  })

  test("all three: two overlays, evenly phased across the cycle", () => {
    const facts = { turn: true, subagents: 1, jobs: 1 }
    expect(busyOverlays(facts, AGENT)).toEqual(["var(--box-accent-subagent)", "var(--box-indicator-job)"])
    expect(busyDelay(0, 2)).toBe("-0.87s")
    expect(busyDelay(1, 2)).toBe("-1.73s")
  })
})

describe("busy shown", () => {
  test("own turn alone shows", () => {
    expect(busyShown({ turn: true, subagents: 0, jobs: 0 })).toBe(true)
  })

  test("an open subagent shows with no turn in flight", () => {
    expect(busyShown({ turn: false, subagents: 1, jobs: 0 })).toBe(true)
  })

  test("a running job shows with no turn in flight", () => {
    expect(busyShown({ turn: false, subagents: 0, jobs: 1 })).toBe(true)
  })

  test("nothing running shows nothing", () => {
    expect(busyShown({ turn: false, subagents: 0, jobs: 0 })).toBe(false)
  })
})
