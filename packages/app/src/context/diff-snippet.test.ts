import { describe, expect, test } from "bun:test"
import { diffSnippet } from "./diff-snippet"

const lines = (n: number, edit: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join("\n") + "\n"

describe("diffSnippet", () => {
  test("the header numbers the slice it emits, not the whole hunk", () => {
    const before = lines(20)
    const after = lines(20, { 10: "changed 10", 14: "changed 14" })
    expect(diffSnippet(before, after, { start: 14, end: 14, side: "additions" })).toBe(
      ["@@ -13,4 +13,4 @@", " line 13", "-line 14", "+changed 14", " line 15", " line 16"].join("\n"),
    )
  })

  test("a hit near the hunk start counts only the padded lines it keeps", () => {
    const before = lines(20)
    const after = lines(20, { 10: "changed 10" })
    expect(diffSnippet(before, after, { start: 10, end: 10, side: "additions" })).toBe(
      ["@@ -9,4 +9,4 @@", " line 9", "-line 10", "+changed 10", " line 11", " line 12"].join("\n"),
    )
  })
})
