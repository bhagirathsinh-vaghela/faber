import { describe, expect, test } from "bun:test"
import { HEARTBEAT_MS, IDLE_MS, RESUME_MS } from "@opencode-ai/util/stream"

describe("stream liveness budgets", () => {
  // Any budget at or under one beat condemns a stream whose next beat simply
  // has not come due, so a quiet-but-healthy connection is torn down and every
  // app switch becomes a reconnect.
  test("every budget outlives a single heartbeat", () => {
    expect(RESUME_MS).toBeGreaterThan(HEARTBEAT_MS)
    expect(IDLE_MS).toBeGreaterThan(HEARTBEAT_MS)
  })

  test("the idle budget tolerates a delayed beat rather than one exactly on time", () => {
    expect(IDLE_MS).toBeGreaterThanOrEqual(HEARTBEAT_MS * 2)
  })

  // Silence on resume is more suspicious than silence mid-stream, so it is
  // judged sooner — but only after a beat has genuinely had its chance.
  test("resume is judged sooner than steady-state silence", () => {
    expect(RESUME_MS).toBeLessThan(IDLE_MS)
  })

  // Middleboxes on mobile networks drop connections carrying no bytes, and the
  // kernel can abandon its TCP probes near 25s.
  test("the beat stays under the interval that mobile networks reap", () => {
    expect(HEARTBEAT_MS).toBeLessThan(25000)
  })
})
