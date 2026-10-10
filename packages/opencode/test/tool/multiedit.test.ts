import { describe, expect, test } from "bun:test"
import path from "path"
import { MultiEditTool } from "../../src/tool/multiedit"
import { SessionPrompt } from "../../src/session/prompt"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

type Edit = { oldString: string; newString: string; replaceAll?: boolean }

const multiedit = async (filePath: string, edits: Edit[]) =>
  (await MultiEditTool.init()).execute({ filePath, edits }, ctx)

describe("multiedit", () => {
  test("applies every edit to the file in one call", async () => {
    await using workspace = await tmpdir({ init: (dir) => Bun.write(path.join(dir, "f.txt"), "a\nb\nc\n") })
    await Instance.provide({
      directory: workspace.path,
      fn: async () => {
        const file = path.join(workspace.path, "f.txt")
        const edited = await multiedit(file, [
          { oldString: "a", newString: "1" },
          { oldString: "c", newString: "3" },
        ])
        expect(edited.output).toContain("updated successfully")
        expect(await Bun.file(file).text()).toBe("1\nb\n3\n")
      },
    })
  })

  test("each edit applies to the result of the ones before it", async () => {
    await using workspace = await tmpdir({ init: (dir) => Bun.write(path.join(dir, "f.txt"), "a\nb\nc\n") })
    await Instance.provide({
      directory: workspace.path,
      fn: async () => {
        const file = path.join(workspace.path, "f.txt")
        await multiedit(file, [
          { oldString: "a", newString: "x" },
          { oldString: "x", newString: "y" },
        ])
        expect(await Bun.file(file).text()).toBe("y\nb\nc\n")
      },
    })
  })

  test("one failing edit writes nothing", async () => {
    await using workspace = await tmpdir({ init: (dir) => Bun.write(path.join(dir, "f.txt"), "a\nb\nc\n") })
    await Instance.provide({
      directory: workspace.path,
      fn: async () => {
        const file = path.join(workspace.path, "f.txt")
        await expect(
          multiedit(file, [
            { oldString: "a", newString: "1" },
            { oldString: "missing", newString: "3" },
          ]),
        ).rejects.toThrow("oldString not found in content")
        expect(await Bun.file(file).text()).toBe("a\nb\nc\n")
      },
    })
  })

  test("an empty first oldString creates the file, and later edits apply to it", async () => {
    await using workspace = await tmpdir()
    await Instance.provide({
      directory: workspace.path,
      fn: async () => {
        const file = path.join(workspace.path, "new.txt")
        await multiedit(file, [
          { oldString: "", newString: "hello\nworld\n" },
          { oldString: "world", newString: "there" },
        ])
        expect(await Bun.file(file).text()).toBe("hello\nthere\n")
      },
    })
  })

  test("its result stamps the file for the next turn and carries the edit card's patch", async () => {
    await using workspace = await tmpdir({ init: (dir) => Bun.write(path.join(dir, "f.txt"), "a\nb\nc\n") })
    await Instance.provide({
      directory: workspace.path,
      fn: async () => {
        const file = path.join(workspace.path, "f.txt")
        const edits = [
          { oldString: "a", newString: "1" },
          { oldString: "c", newString: "3" },
        ]
        const edited = await multiedit(file, edits)
        const stamps = SessionPrompt.fileStamps({
          type: "tool",
          state: { status: "completed", tool: "multiedit", input: { filePath: file, edits }, metadata: edited.metadata },
        } as never)
        expect(stamps).toEqual([
          { file, mtime: edited.metadata.mtime as number, hash: edited.metadata.hash, offset: undefined, limit: undefined },
        ])
        expect(edited.metadata.diff).toContain("@@ -1,3 +1,3 @@")
      },
    })
  })
})
