import { describe, expect, test } from "bun:test"
import { hold, release, stale } from "./busy"

describe("stale", () => {
  test("names each session shown busy that the complete frame omits, and nothing idle or listed", () => {
    const shown = {
      turning: { turn: true, subagents: 0, jobs: 0 },
      waiting: { turn: false, subagents: 2, jobs: 0 },
      running: { turn: false, subagents: 0, jobs: 1 },
      listed: { turn: true, subagents: 1, jobs: 1 },
      idle: { turn: false, subagents: 0, jobs: 0 },
    }
    const live = { listed: { directory: "/p", turn: true, subagents: 1, jobs: 1 } }
    expect(stale(shown, live)).toEqual(["turning", "waiting", "running"])
  })

  test("an empty complete frame idles everything shown busy", () => {
    expect(stale({ a: { turn: true, subagents: 0, jobs: 0 } }, {})).toEqual(["a"])
  })

  test("a session just pressed is kept until released or the hold runs out", () => {
    const shown = { pressed: { turn: true, subagents: 0, jobs: 0 } }
    hold("pressed", 1_000)
    expect(stale(shown, {}, 1_000 + 29_999)).toEqual([])
    expect(stale(shown, {}, 1_000 + 30_000)).toEqual(["pressed"])
    hold("pressed", 1_000)
    release("pressed")
    expect(stale(shown, {}, 1_001)).toEqual(["pressed"])
  })
})
