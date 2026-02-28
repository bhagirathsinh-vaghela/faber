import { describe, expect, test } from "bun:test"
import path from "path"
import { EditTool, replace } from "../../src/tool/edit"
import { WriteTool } from "../../src/tool/write"
import { FileTime } from "../../src/file/time"
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

describe("tool.edit line endings", () => {
  test("a multi-line LF oldString matches a CRLF file and the file keeps CRLF", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.txt"), "one\r\ntwo\r\nthree\r\n")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = path.join(tmp.path, "a.txt")
        FileTime.read(ctx.sessionID, file)
        const edit = await EditTool.init()
        await edit.execute({ filePath: file, oldString: "one\ntwo", newString: "1\n2" }, ctx)
        expect(await Bun.file(file).text()).toBe("1\r\n2\r\nthree\r\n")
      },
    })
  })
})

describe("tool.edit and tool.write encodings", () => {
  test("an edit in an LF file keeps the file's stray CRLF lines", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.txt"), "a\nb\r\nc\nd\n")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = path.join(tmp.path, "a.txt")
        FileTime.read(ctx.sessionID, file)
        const edit = await EditTool.init()
        await edit.execute({ filePath: file, oldString: "a", newString: "A" }, ctx)
        expect(await Bun.file(file).text()).toBe("A\nb\r\nc\nd\n")
      },
    })
  })

  test("writing a CRLF file diffs only the changed lines", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.txt"), "a\r\nb\r\n")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = path.join(tmp.path, "a.txt")
        FileTime.read(ctx.sessionID, file)
        const asked: string[] = []
        const write = await WriteTool.init()
        await write.execute(
          { filePath: file, content: "a\nB\n" },
          { ...ctx, ask: async (req: { metadata: { diff: string } }) => void asked.push(req.metadata.diff) },
        )
        const changed = asked[0].split("\n").filter((line) => /^[-+][^-+]/.test(line))
        expect(changed).toEqual(["-b", "+B"])
        expect(await Bun.file(file).text()).toBe("a\r\nB\r\n")
      },
    })
  })
})

describe("tool.edit replace", () => {
  test("deleting with replaceAll also removes an occurrence with no trailing newline", () => {
    expect(replace("x\nfoo\nbar foo", "foo", "", true)).toBe("x\nbar ")
  })

  test("deleting a single occurrence consumes its trailing newline", () => {
    expect(replace("a\nfoo\nb\n", "foo", "")).toBe("a\nb\n")
  })

  test("multiple matches without replaceAll fail", () => {
    expect(() => replace("foo foo", "foo", "bar")).toThrow(
      "Found multiple matches for oldString. Provide more surrounding lines in oldString to identify the correct match.",
    )
  })
})
