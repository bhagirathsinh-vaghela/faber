import { describe, expect, test } from "bun:test"
import { busyBase, busyDelay, busyOverlays, busyShown } from "./busy-tint"

const AGENT = "#agent"

describe("busy tints", () => {
  test("own turn alone: agent colour, no overlay", () => {
    const facts = { busySelf: true, busyDescendant: false, busyHelper: false }
    expect(busyBase(facts, AGENT)).toBe(AGENT)
    expect(busyOverlays(facts, AGENT)).toEqual([])
  })

  test("own turn + subtask: task accent crossfades over the agent base", () => {
    const facts = { busySelf: true, busyDescendant: true, busyHelper: false }
    expect(busyBase(facts, AGENT)).toBe(AGENT)
    expect(busyOverlays(facts, AGENT)).toEqual(["var(--box-accent-task)"])
    // A single overlay sits at the half-cycle, which is what a two-colour
    // cross-fade holds: adding a third state must not disturb this pair.
    expect(busyDelay(0, 1)).toBe("-1.30s")
  })

  test("own turn + helper: helper accent crossfades over the agent base", () => {
    const facts = { busySelf: true, busyDescendant: false, busyHelper: true }
    expect(busyBase(facts, AGENT)).toBe(AGENT)
    expect(busyOverlays(facts, AGENT)).toEqual(["var(--box-accent-helper)"])
  })

  test("all three: two overlays, evenly phased across the cycle", () => {
    const facts = { busySelf: true, busyDescendant: true, busyHelper: true }
    expect(busyOverlays(facts, AGENT)).toEqual(["var(--box-accent-task)", "var(--box-accent-helper)"])
    expect(busyDelay(0, 2)).toBe("-0.87s")
    expect(busyDelay(1, 2)).toBe("-1.73s")
  })

  test("helper alone: helper accent is the base", () => {
    const facts = { busySelf: false, busyDescendant: false, busyHelper: true }
    expect(busyBase(facts, AGENT)).toBe("var(--box-accent-helper)")
    expect(busyOverlays(facts, AGENT)).toEqual([])
  })

  test("no agent colour resolved: base falls back to the interactive tint", () => {
    const facts = { busySelf: true, busyDescendant: false, busyHelper: false }
    expect(busyBase(facts, undefined)).toBe("var(--icon-interactive-base)")
  })

  test("busy with no fact set: the base still resolves to a colour", () => {
    const facts = { busySelf: false, busyDescendant: false, busyHelper: false }
    expect(busyBase(facts, AGENT)).toBe("var(--box-accent-task)")
    expect(busyOverlays(facts, AGENT)).toEqual([])
  })
})

describe("busy tints — a running job", () => {
  test("a job alone: the job accent is the base", () => {
    const facts = { busySelf: false, busyDescendant: false, busyHelper: false, busyJob: true }
    expect(busyBase(facts, AGENT)).toBe("var(--box-accent-job)")
    expect(busyOverlays(facts, AGENT)).toEqual([])
  })

  test("own turn + job: the job accent crossfades over the agent base", () => {
    const facts = { busySelf: true, busyDescendant: false, busyHelper: false, busyJob: true }
    expect(busyBase(facts, AGENT)).toBe(AGENT)
    expect(busyOverlays(facts, AGENT)).toEqual(["var(--box-accent-job)"])
  })

  test("all four: three overlays, evenly phased", () => {
    const facts = { busySelf: true, busyDescendant: true, busyHelper: true, busyJob: true }
    expect(busyOverlays(facts, AGENT)).toEqual([
      "var(--box-accent-task)",
      "var(--box-accent-helper)",
      "var(--box-accent-job)",
    ])
    expect(busyDelay(0, 3)).toBe("-0.65s")
    expect(busyDelay(2, 3)).toBe("-1.95s")
  })
})

// A job outlives the turn that started it, so `busy` is false while it runs.
// An indicator keyed on that alone goes dark on a session that is still
// waiting, which is what a reader takes for finished.
describe("busy shown", () => {
  test("a running job shows an indicator with no turn in flight", () => {
    expect(busyShown({ busy: false, busySelf: false, busyDescendant: false, busyJob: true })).toBe(true)
  })

  test("a helper owing a report shows one too", () => {
    expect(busyShown({ busy: false, busySelf: false, busyDescendant: false, busyHelper: true })).toBe(true)
  })

  test("nothing running shows nothing", () => {
    expect(busyShown({ busy: false, busySelf: false, busyDescendant: false })).toBe(false)
  })
})
