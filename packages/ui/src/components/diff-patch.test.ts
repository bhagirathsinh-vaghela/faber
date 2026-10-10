import { expect, test } from "bun:test"
import { getSingularPatch } from "@pierre/diffs"

// The edit tool persists a jsdiff `createTwoFilesPatch` (Index + === header),
// capped by a trailing truncation marker; the edit card renders it directly.
const stored = [
  "Index: /repo/src/app.ts",
  "===================================================================",
  "--- /repo/src/app.ts",
  "+++ /repo/src/app.ts",
  "@@ -203,4 +203,5 @@",
  " const a = 1",
  "-const b = 2",
  "+const b = 3",
  "+const c = 4",
  " const d = 5",
  " const e = 6",
  "",
].join("\n")

const hunks = (patch: string) =>
  getSingularPatch(patch).hunks.map((hunk) => ({
    deletionStart: hunk.deletionStart,
    deletionCount: hunk.deletionCount,
    additionStart: hunk.additionStart,
    additionCount: hunk.additionCount,
  }))

test("a stored edit patch keeps the file's real line positions", () =>
  expect(hunks(stored)).toEqual([{ deletionStart: 203, deletionCount: 4, additionStart: 203, additionCount: 5 }]))

test("a truncated stored patch still parses with its positions", () =>
  expect(hunks(`${stored}\n\n... [12 lines truncated] ...`)).toEqual([
    { deletionStart: 203, deletionCount: 4, additionStart: 203, additionCount: 5 },
  ]))
