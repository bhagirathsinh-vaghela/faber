import { expect, test } from "bun:test"
import { patchLines } from "./message-part"

test("a unified diff classifies headers, hunks, additions, deletions and context", () => {
  const diff = [
    "Index: a.md",
    "===================================================================",
    "--- a.md",
    "+++ a.md",
    "@@ -1,3 +1,3 @@",
    " keep",
    "-old",
    "+new",
    "--- rule",
    "+++ bold",
    "\\ No newline at end of file",
    "",
    "... [4 lines truncated] ...",
  ].join("\n")
  expect(patchLines(diff).map((line) => line.kind)).toEqual([
    "meta",
    "meta",
    "meta",
    "meta",
    "hunk",
    "context",
    "delete",
    "add",
    "delete",
    "add",
    "meta",
    "meta",
    "meta",
  ])
})

test("a diff without a hunk is all header", () => {
  expect(patchLines("--- a\n+++ b").map((line) => line.kind)).toEqual(["meta", "meta"])
})
