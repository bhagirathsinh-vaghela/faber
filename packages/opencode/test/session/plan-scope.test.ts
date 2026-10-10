import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util/log"
import type { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const plans = (data: string) => [path.join(".opencode", "plans", "*.md"), path.join(data, "plans", "*.md")]

async function within(fn: (dir: string) => void) {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({ directory: tmp.path, fn: async () => fn(tmp.path) })
}

const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n")

describe("toolDenial under the plan allowlist", () => {
  test("an MCP tool its server marks read-only passes; a write-capable one is refused", async () => {
    await within(() => {
      const allowed = SessionPrompt.allowlist({} as Session.Info, "plan", ["read", "write"])
      expect(SessionPrompt.toolDenial(allowed, "docs_search", {}, { readOnly: true })).toBeUndefined()
      expect(SessionPrompt.toolDenial(allowed, "docs_update", {}, { readOnly: false })).toBe(
        'Tool "docs_update" is not available for this task. Available tools: read, write, mcp:read',
      )
    })
  })

  test("a native tool cannot ride the MCP sentinel", async () => {
    await within(() => {
      const allowed = SessionPrompt.allowlist({} as Session.Info, "plan", ["read"])
      expect(SessionPrompt.toolDenial(allowed, "bash", {})).toBe(
        'Tool "bash" is not available for this task. Available tools: read, mcp:read',
      )
    })
  })
})

describe("toolDenial for path-scoped tools", () => {
  test("a plan file passes, relative or absolute", async () => {
    await within((dir) => {
      const allowed = [{ id: "write", paths: plans("/data") }]
      expect(SessionPrompt.toolDenial(allowed, "write", { filePath: ".opencode/plans/a.md" })).toBeUndefined()
      expect(
        SessionPrompt.toolDenial(allowed, "write", { filePath: path.join(dir, ".opencode/plans/a.md") }),
      ).toBeUndefined()
      expect(SessionPrompt.toolDenial(allowed, "write", { filePath: "/data/plans/b.md" })).toBeUndefined()
    })
  })

  test("`..` cannot step out of the plans folder", async () => {
    await within(() => {
      const allowed = [{ id: "edit", paths: plans("/data") }]
      expect(SessionPrompt.toolDenial(allowed, "edit", { filePath: ".opencode/plans/../../src/index.md" })).toBe(
        `Tool "edit" is restricted to ${plans("/data").join(", ")} for this task. ".opencode/plans/../../src/index.md" is not allowed.`,
      )
      expect(SessionPrompt.toolDenial(allowed, "edit", { filePath: "/data/plans/../../etc/x.md" })).toBe(
        `Tool "edit" is restricted to ${plans("/data").join(", ")} for this task. "/data/plans/../../etc/x.md" is not allowed.`,
      )
    })
  })

  test("apply_patch is scoped by every path its patch names", async () => {
    await within(() => {
      const allowed = [{ id: "apply_patch", paths: plans("/data") }]
      const inside = patch("*** Add File: .opencode/plans/a.md", "+plan")
      const added = patch("*** Add File: .opencode/plans/a.md", "+plan", "*** Add File: src/x.ts", "+code")
      const moved = patch("*** Update File: .opencode/plans/a.md", "*** Move to: src/a.md", "@@", "-plan", "+plan")
      expect(SessionPrompt.toolDenial(allowed, "apply_patch", { patchText: inside })).toBeUndefined()
      expect(SessionPrompt.toolDenial(allowed, "apply_patch", { patchText: added })).toBe(
        `Tool "apply_patch" is restricted to ${plans("/data").join(", ")} for this task. "src/x.ts" is not allowed.`,
      )
      expect(SessionPrompt.toolDenial(allowed, "apply_patch", { patchText: moved })).toBe(
        `Tool "apply_patch" is restricted to ${plans("/data").join(", ")} for this task. "src/a.md" is not allowed.`,
      )
    })
  })

  test("a call that names no readable path is denied", async () => {
    await within(() => {
      const allowed = [
        { id: "write", paths: plans("/data") },
        { id: "apply_patch", paths: plans("/data") },
      ]
      expect(SessionPrompt.toolDenial(allowed, "write", {})).toBe(`Tool "write" requires a file path for this task.`)
      expect(SessionPrompt.toolDenial(allowed, "apply_patch", { patchText: "not a patch" })).toBe(
        `Tool "apply_patch" requires a file path for this task.`,
      )
    })
  })
})
