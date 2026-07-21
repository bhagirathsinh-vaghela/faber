import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"

describe("id.Identifier.seed", () => {
  test("a mint after seeding to a future timestamp sorts above pre-seed ids", () => {
    const before = Identifier.ascending("message")
    // Simulate the disk holding an id minted far in the future (a prior process
    // that held a forward clock). Seed to it, then a fresh mint must sort above.
    Identifier.seed(Date.now() + 60_000)
    const after = Identifier.ascending("message")
    expect(after > before).toBe(true)
  })

  test("mints stay strictly ascending after a seed", () => {
    Identifier.seed(Date.now() + 120_000)
    const ids = Array.from({ length: 50 }, () => Identifier.ascending("message"))
    const sorted = [...ids].sort()
    expect(ids).toStrictEqual(sorted)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("seeding to a stale (past) timestamp does not lower the floor", () => {
    Identifier.seed(Date.now() + 180_000)
    const high = Identifier.ascending("message")
    Identifier.seed(1)
    const next = Identifier.ascending("message")
    expect(next > high).toBe(true)
  })

  test("a large seed raises the decoded timestamp of subsequent mints", () => {
    const low = Identifier.timestamp(Identifier.ascending("message"))
    Identifier.seed(Date.now() + 600_000)
    const high = Identifier.timestamp(Identifier.ascending("message"))
    expect(high).toBeGreaterThan(low)
  })
})
