import { describe, expect, test } from "bun:test"
import path from "path"
import * as fs from "fs"
import { ReadTool } from "../../src/tool/read"
import { EditTool } from "../../src/tool/edit"
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

// Push a file's mtime into the future without changing its bytes — the exact
// situation a formatter rewrite-in-place / editor save / our own post-write
// re-stamp produces, and the one that used to force a spurious re-read.
function bumpMtime(file: string, msAhead = 5000) {
  const future = new Date(Date.now() + msAhead)
  fs.utimesSync(file, future, future)
}

describe("FileTime content-fallback (mtime bump, unchanged bytes)", () => {
  test("edit succeeds when mtime moved but content is byte-identical", async () => {
    await using tmp = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "f.txt"), "hello world\n"),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = path.join(tmp.path, "f.txt")
        const read = await ReadTool.init()
        await read.execute({ filePath: file }, ctx)

        // A hash was recorded at read time.
        expect(FileTime.get(ctx.sessionID, file)?.hash).toBeString()

        // mtime jumps forward, bytes unchanged (formatter / editor-save case).
        bumpMtime(file)

        // The old behavior threw here. With the content fallback it proceeds.
        const edit = await EditTool.init()
        const result = await edit.execute({ filePath: file, oldString: "hello world", newString: "goodbye world" }, ctx)
        expect(result.output).toContain("updated successfully")
        expect(await Bun.file(file).text()).toBe("goodbye world\n")
      },
    })
  })

  test("edit still throws when content genuinely changed under a bumped mtime", async () => {
    await using tmp = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "f.txt"), "hello world\n"),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = path.join(tmp.path, "f.txt")
        const read = await ReadTool.init()
        await read.execute({ filePath: file }, ctx)

        // An outside writer changes the bytes AND the mtime moves.
        await Bun.write(file, "TAMPERED CONTENT\n")
        bumpMtime(file)

        const edit = await EditTool.init()
        const err = await edit
          .execute({ filePath: file, oldString: "hello world", newString: "x" }, ctx)
          .then(() => null)
          .catch((e: Error) => e)
        expect(err).toBeInstanceOf(Error)
        expect(err!.message).toContain("modified since it was last read")
      },
    })
  })

  test("consecutive edits do not trip the guard on our own writes", async () => {
    await using tmp = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "f.txt"), "one\ntwo\nthree\n"),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = path.join(tmp.path, "f.txt")
        const read = await ReadTool.init()
        await read.execute({ filePath: file }, ctx)

        const edit = await EditTool.init()
        // First edit re-stamps via FileTime.restamp (real post-write mtime+hash).
        await edit.execute({ filePath: file, oldString: "one", newString: "1" }, ctx)
        // Second edit with no intervening read must NOT throw — this is the
        // self-inflicted false positive the bare Date.now() re-stamp caused.
        const second = await edit.execute({ filePath: file, oldString: "two", newString: "2" }, ctx)
        expect(second.output).toContain("updated successfully")
        expect(await Bun.file(file).text()).toBe("1\n2\nthree\n")
      },
    })
  })

  test("edit survives a seed() from the edit part on the next turn", async () => {
    await using tmp = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "f.txt"), "one\ntwo\nthree\n"),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = path.join(tmp.path, "f.txt")
        const read = await ReadTool.init()
        await read.execute({ filePath: file }, ctx)

        const edit = await EditTool.init()
        const first = await edit.execute({ filePath: file, oldString: "one", newString: "1" }, ctx)

        // Reproduce the cross-turn path: at the top of the next turn, prompt.ts
        // rebuilds FileTime from durable tool parts via seed(). Feed it the edit
        // part's persisted mtime+hash (the bug was seeding only read parts, which
        // restored the stale pre-edit state and made the next edit throw).
        expect(first.metadata.mtime).toBeNumber()
        expect(first.metadata.hash).toBeString()
        FileTime.seed(ctx.sessionID, [
          { file, mtime: first.metadata.mtime as number, hash: first.metadata.hash as string },
        ])

        const second = await edit.execute({ filePath: file, oldString: "three", newString: "3" }, ctx)
        expect(second.output).toContain("updated successfully")
        expect(await Bun.file(file).text()).toBe("1\ntwo\n3\n")
      },
    })
  })

  test("re-reading the same range returns the unchanged stub", async () => {
    await using tmp = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "f.txt"), "a\nb\nc\nd\n"),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = path.join(tmp.path, "f.txt")
        const read = await ReadTool.init()
        const first = await read.execute({ filePath: file }, ctx)
        expect(first.output).toContain("<file>")

        const second = await read.execute({ filePath: file }, ctx)
        expect(second.output).toContain("<file_unchanged>")
      },
    })
  })

  test("reading a different range after a full read does not stub", async () => {
    await using tmp = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "f.txt"), Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = path.join(tmp.path, "f.txt")
        const read = await ReadTool.init()
        const full = await read.execute({ filePath: file }, ctx)
        expect(full.output).toContain("line 0")

        const windowed = await read.execute({ filePath: file, offset: 20, limit: 5 }, ctx)
        expect(windowed.output).not.toContain("<file_unchanged>")
        expect(windowed.output).toContain("line 20")
      },
    })
  })

  test("an edit stamp does not stub a subsequent read", async () => {
    await using tmp = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "f.txt"), "one\ntwo\nthree\n"),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = path.join(tmp.path, "f.txt")
        const read = await ReadTool.init()
        await read.execute({ filePath: file }, ctx)

        const edit = await EditTool.init()
        await edit.execute({ filePath: file, oldString: "two", newString: "2" }, ctx)

        const after = await read.execute({ filePath: file }, ctx)
        expect(after.output).not.toContain("<file_unchanged>")
        expect(after.output).toContain("2")
      },
    })
  })

  test("assert requires a prior read", async () => {
    await using tmp = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "f.txt"), "x\n"),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = path.join(tmp.path, "f.txt")
        const err = await FileTime.assert(ctx.sessionID, file)
          .then(() => null)
          .catch((e: Error) => e)
        expect(err).toBeInstanceOf(Error)
        expect(err!.message).toContain("must read file")
      },
    })
  })
})
