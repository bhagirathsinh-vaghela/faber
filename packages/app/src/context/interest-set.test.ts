import { describe, expect, test } from "bun:test"
import { buildInterestSet } from "./global-sync"

const session = (id: string, parentID?: string) => ({ id, parentID })

describe("buildInterestSet — children of live/open sessions join the set", () => {
  test("a child of the open session is in the set", () => {
    const sessions = [[session("root1"), session("child1", "root1")]]
    const ids = buildInterestSet(new Set(), "root1", sessions)
    expect(new Set(ids)).toEqual(new Set(["root1", "child1"]))
  })

  test("a child of a live root (not open) is in the set", () => {
    const sessions = [[session("liveRoot"), session("child1", "liveRoot")]]
    const ids = buildInterestSet(new Set(["liveRoot"]), undefined, sessions)
    expect(new Set(ids)).toEqual(new Set(["liveRoot", "child1"]))
  })

  test("a child of a non-live non-open root is NOT in the set", () => {
    const sessions = [[session("idleRoot"), session("child1", "idleRoot")]]
    const ids = buildInterestSet(new Set(), "otherSession", sessions)
    expect(new Set(ids)).toEqual(new Set(["otherSession"]))
  })

  test("a grandchild (child of a child) is NOT added by the one-level rule", () => {
    const sessions = [[session("root1"), session("child1", "root1"), session("grandchild1", "child1")]]
    const ids = buildInterestSet(new Set(["root1"]), undefined, sessions)
    expect(new Set(ids)).toEqual(new Set(["root1", "child1"]))
  })

  test("a child qualifying via both open and live produces each id once", () => {
    const sessions = [[session("root1"), session("child1", "root1")]]
    const ids = buildInterestSet(new Set(["root1"]), "root1", sessions)
    expect(ids.filter((id) => id === "root1")).toHaveLength(1)
    expect(ids.filter((id) => id === "child1")).toHaveLength(1)
    expect(new Set(ids)).toEqual(new Set(["root1", "child1"]))
  })
})
