import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"

const timeField = (id: string) => id.slice(4, 20)

describe("id.Identifier.seed", () => {
  test("a mint after seeding to a future timestamp sorts above pre-seed ids", () => {
    const before = Identifier.ascending("message")
    Identifier.seed(Identifier.create("message", false, Date.now() + 60_000))
    const after = Identifier.ascending("message")
    expect(after > before).toBe(true)
  })

  test("mints stay strictly ascending after a seed", () => {
    Identifier.seed(Identifier.create("message", false, Date.now() + 120_000))
    const ids = Array.from({ length: 50 }, () => Identifier.ascending("message"))
    const sorted = [...ids].sort()
    expect(ids).toStrictEqual(sorted)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("seeding to a stale (past) timestamp does not lower the floor", () => {
    Identifier.seed(Identifier.create("message", false, Date.now() + 180_000))
    const high = Identifier.ascending("message")
    Identifier.seed(Identifier.create("message", false, 1))
    const next = Identifier.ascending("message")
    expect(next > high).toBe(true)
  })

  test("a large seed raises the decoded timestamp of subsequent mints", () => {
    const low = Identifier.timestamp(Identifier.ascending("message"))
    Identifier.seed(Identifier.create("message", false, Date.now() + 600_000))
    const high = Identifier.timestamp(Identifier.ascending("message"))
    expect(high).toBeGreaterThan(low)
  })

  const mintAfterRestart = async (seeds: string[], ts: number) => {
    const module = new URL("../../src/id/id.ts", import.meta.url).pathname
    const source = `
      const { Identifier } = await import(${JSON.stringify(module)})
      for (const id of ${JSON.stringify(seeds)}) Identifier.seed(id)
      console.log(Identifier.create("message", false, ${ts}))
    `
    const proc = Bun.spawn(["bun", "-e", source], { stdout: "pipe" })
    return (await new Response(proc.stdout).text()).trim()
  }

  test("a restarted process reseeded from a persisted id does not reissue its time field", async () => {
    const ts = Date.now() + 900_000
    const persisted = Identifier.create("message", false, ts)

    const minted = await mintAfterRestart([persisted], ts)

    expect(timeField(minted)).not.toBe(timeField(persisted))
    expect(minted > persisted).toBe(true)
  })

  test("a restart reseeded from every id of a millisecond mints above all of them", async () => {
    const ts = Date.now() + 960_000
    const persisted = Array.from({ length: 5 }, () => Identifier.create("message", false, ts))

    const minted = await mintAfterRestart(persisted, ts)

    expect(persisted.every((id) => minted > id)).toBe(true)
    expect(new Set([...persisted, minted].map(timeField)).size).toBe(6)
  })
})

describe("id.Identifier backward clock", () => {
  test("a clock that steps backward keeps minting ids above the ones already issued", () => {
    const ts = Date.now() + 1_200_000
    const before = Identifier.create("message", false, ts)
    const after = Identifier.create("message", false, ts - 5_000)
    expect(after > before).toBe(true)
    expect(timeField(after)).not.toBe(timeField(before))
  })

  test("repeated mints across a backward step stay unique and ascending", () => {
    const ts = Date.now() + 1_500_000
    const ids = [
      Identifier.create("message", false, ts),
      Identifier.create("message", false, ts - 1),
      Identifier.create("message", false, ts - 900),
      Identifier.create("message", false, ts),
    ]
    expect(ids).toStrictEqual([...ids].sort())
    expect(new Set(ids.map(timeField)).size).toBe(ids.length)
  })
})

describe("id.Identifier counter overflow", () => {
  test("more mints than the counter holds stay unique and ascending", () => {
    const ts = Date.now() + 2_000_000
    const ids = Array.from({ length: 10_000 }, () => Identifier.create("message", false, ts))
    expect(ids).toStrictEqual([...ids].sort())
    expect(new Set(ids.map(timeField)).size).toBe(ids.length)
  })

  test("a later millisecond still sorts above every id that overflowed into it", () => {
    const ts = Date.now() + 2_500_000
    const overflowed = Array.from({ length: 5_000 }, () => Identifier.create("message", false, ts))
    const later = Identifier.create("message", false, ts + 1)
    expect(overflowed.every((id) => later > id)).toBe(true)
  })
})

describe("id.Identifier.compare", () => {
  test("orders by mint order, including within one millisecond", () => {
    const ts = Date.now() + 3_000_000
    const ids = Array.from({ length: 20 }, () => Identifier.create("message", false, ts))
    const shuffled = [...ids].reverse()
    expect(shuffled.toSorted(Identifier.compare)).toStrictEqual(ids)
  })

  test("orders a 6-byte id below an 8-byte one that a lexical sort puts first", () => {
    const legacy = "msg_01a01642d091" + "abcdefghijklmn"
    const current = "msg_001a01642d091001" + "abcdefghijklmn"
    expect(legacy < current).toBe(false)
    expect(Identifier.compare(legacy, current)).toBeLessThan(0)
  })

  test("is a total order: equal ids compare equal", () => {
    const id = Identifier.ascending("message")
    expect(Identifier.compare(id, id)).toBe(0)
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
    const ts = Date.now() + 3_600_000
    const id = Identifier.create("message", false, ts)
    const decoded = Identifier.timestamp(id)
    expect(decoded).toBe(ts)
  })
})
