import { describe, expect, test } from "bun:test"
import { health } from "./health"

describe("health", () => {
  test("a live stream is the only thing that reports currency", () => {
    expect(health({ polled: true, stream: true })).toBe("live")
  })

  // The state a suspended mobile tab wakes into: the poll recovers on its own
  // interval while the event stream stays dead, so a poll-only signal would
  // claim the transcript is current when nothing is feeding it.
  test("a reachable server with no stream is stale, never live", () => {
    expect(health({ polled: true, stream: undefined })).toBe("stale")
    expect(health({ polled: true, stream: false })).toBe("stale")
  })

  test("a delivering stream outranks a poll that timed out on a slow link", () => {
    expect(health({ polled: false, stream: true })).toBe("live")
  })

  test("an unreachable server with no stream is down", () => {
    expect(health({ polled: false, stream: undefined })).toBe("down")
    expect(health({ polled: false, stream: false })).toBe("down")
  })

  test("a stream that failed before any poll answered is down", () => {
    expect(health({ polled: undefined, stream: false })).toBe("down")
  })

  test("nothing known yet reports nothing", () => {
    expect(health({})).toBe(undefined)
  })

  test("a stream delivering before the first poll already proves currency", () => {
    expect(health({ polled: undefined, stream: true })).toBe("live")
  })
})
