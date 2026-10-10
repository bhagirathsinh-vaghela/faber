import { expect, test } from "bun:test"
import { diagnosticsReport } from "../../src/tool/write"

const error = (message: string) => ({
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  message,
  severity: 1 as const,
})

// The language server keeps every file it has ever checked, including files a
// read pulled in from another repo. Only the written file and files in the
// project can be affected by this write, so only those are reported.
test("a write reports its own errors and project files, never files outside the project", () =>
  expect(
    diagnosticsReport(
      {
        "/repo/src/a.ts": [error("in the written file")],
        "/repo/src/b.ts": [error("in an importer")],
        "/elsewhere/x.ts": [error("in another repo")],
      },
      "/repo/src/a.ts",
      "/repo",
    ),
  ).toBe(
    [
      "",
      "",
      "LSP errors detected in this file, please fix:",
      '<diagnostics file="/repo/src/a.ts">',
      "ERROR [1:1] in the written file",
      "</diagnostics>",
      "",
      "LSP errors detected in other files:",
      '<diagnostics file="/repo/src/b.ts">',
      "ERROR [1:1] in an importer",
      "</diagnostics>",
    ].join("\n"),
  ))
