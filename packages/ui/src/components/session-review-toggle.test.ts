import { describe, expect, test } from "bun:test"
import { collapses, toggleAll } from "./session-review-toggle"

describe("collapses", () => {
  test("a listed file open reads Collapse all", () => {
    expect(collapses(["gone.ts", "a.ts"], ["a.ts", "b.ts"])).toBe(true)
  })

  test("only files no longer listed open reads Expand all", () => {
    expect(collapses(["gone.ts"], ["a.ts", "b.ts"])).toBe(false)
  })
})

describe("toggleAll", () => {
  test("a listed file open collapses the list and keeps intent for files not listed", () => {
    expect(toggleAll(["gone.ts", "a.ts"], ["a.ts", "b.ts"])).toEqual(["gone.ts"])
  })

  test("only unlisted files open expands every listed file and keeps them", () => {
    expect(toggleAll(["gone.ts"], ["a.ts", "b.ts"])).toEqual(["gone.ts", "a.ts", "b.ts"])
  })

  test("nothing open expands every listed file", () => {
    expect(toggleAll([], ["a.ts", "b.ts"])).toEqual(["a.ts", "b.ts"])
  })

  test("a file that comes back after a collapse reopens as it was", () => {
    const collapsed = toggleAll(["gone.ts", "a.ts"], ["a.ts"])
    const listed = ["a.ts", "gone.ts"]
    expect(collapsed.filter((file) => listed.includes(file))).toEqual(["gone.ts"])
  })
})
