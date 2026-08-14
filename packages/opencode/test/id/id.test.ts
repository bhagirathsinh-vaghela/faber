import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"

describe("id.Identifier.seed", () => {
  test("a mint after seeding to a future timestamp sorts above pre-seed ids", () => {
    const before = Identifier.ascending("message")
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

describe("id.Identifier 8-byte encoding", () => {
  test("ascending IDs produce 16 hex chars in the time field", () => {
    const id = Identifier.ascending("message")
    const body = id.slice(4)
    expect(body.length).toBe(30)
    expect(body.slice(0, 16)).toMatch(/^[0-9a-f]{16}$/)
  })

  test("descending IDs produce 16 hex chars in the time field", () => {
    const id = Identifier.descending("session")
    const body = id.slice(4)
    expect(body.length).toBe(30)
    expect(body.slice(0, 16)).toMatch(/^[0-9a-f]{16}$/)
  })

  test("timestamp() round-trips through create", () => {
    const ts = Date.now() + 700_000
    Identifier.seed(ts)
    const id = Identifier.create("message", false, ts)
    const decoded = Identifier.timestamp(id)
    expect(decoded).toBe(ts)
  })
})
