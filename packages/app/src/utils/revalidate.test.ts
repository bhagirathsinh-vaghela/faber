import { describe, expect, test } from "bun:test"
import { revalidate } from "./revalidate"

describe("revalidate", () => {
  // A stream that is delivering must be verified, never torn down.
  test("a live stream is verified, not reconnected", () => {
    expect(revalidate(true)).toBe("verify")
  })

  // No stream attached means the loop is between attempts, so the signal is the
  // cue to reconnect now rather than wait out a backoff.
  test("no live stream reconnects", () => {
    expect(revalidate(false)).toBe("reconnect")
  })
})
