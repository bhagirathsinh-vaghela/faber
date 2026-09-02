import { describe, expect, test } from "bun:test"
import path from "path"
import * as fs from "fs"
import { ReadTool } from "../../src/tool/read"
import { EditTool } from "../../src/tool/edit"
import { WriteTool } from "../../src/tool/write"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { FileTime } from "../../src/file/time"
import { SessionPrompt } from "../../src/session/prompt"
import { Bus } from "../../src/bus"
import { File as FileEvents } from "../../src/file"
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

  // Several edits issued in one assistant message are minted in call order but
  // complete in write order, so seed() receives an earlier write's stamp after a
  // later one. The newest stamp must survive that ordering.
  test("seed keeps the newest stamp when entries arrive out of order", async () => {
    await using workspace = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "f.txt"), "x\n"),
    })
    await Instance.provide({
      directory: workspace.path,
      fn: async () => {
        const file = path.join(workspace.path, "f.txt")
        FileTime.seed(ctx.sessionID, [
          { file, mtime: 2000, hash: "newest" },
          { file, mtime: 1000, hash: "stale" },
        ])
        expect(FileTime.get(ctx.sessionID, file)).toMatchObject({ mtime: 2000, hash: "newest" })
      },
    })
  })

  test("an edit survives an out-of-order seed of its own parallel writes", async () => {
    await using workspace = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "f.txt"), "one\ntwo\nthree\n"),
    })
    await Instance.provide({
      directory: workspace.path,
      fn: async () => {
        const file = path.join(workspace.path, "f.txt")
        const read = await ReadTool.init()
        await read.execute({ filePath: file }, ctx)

        const edit = await EditTool.init()
        const written = await edit.execute({ filePath: file, oldString: "one", newString: "1" }, ctx)

        // Push the file's mtime past every stamp so the mtime check cannot pass
        // and the hash decides — which is what makes a stale winner fatal rather
        // than merely wrong. Bytes are untouched, so the post-write hash matches.
        bumpMtime(file)
        const newest = { file, mtime: written.metadata.mtime as number, hash: written.metadata.hash as string }
        const stale = { file, mtime: newest.mtime - 5000, hash: "pre-write" }
        FileTime.seed(ctx.sessionID, [newest, stale])

        const next = await edit.execute({ filePath: file, oldString: "two", newString: "2" }, ctx)
        expect(next.output).toContain("updated successfully")
        expect(await Bun.file(file).text()).toBe("1\n2\nthree\n")
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

// Every tool that writes a file must leave the session able to edit that file
// again — both later in the same turn and on the next turn, where FileTime is
// rebuilt from durable tool parts by SessionPrompt.fileStamps. A write the
// rebuild cannot see makes the model re-read a file it just wrote.
describe("FileTime across a turn boundary (seed from durable parts)", () => {
  // Stand in for the next turn: rebuild FileTime the way the turn loop does,
  // through the same fileStamps() the loop calls, rather than a hand-rolled copy
  // that could pass while production fails.
  function reseed(sessionID: string, parts: { tool: string; input: unknown; metadata: unknown }[]) {
    const entries = parts.flatMap((part) =>
      SessionPrompt.fileStamps({ type: "tool", state: { status: "completed", ...part } } as never),
    )
    FileTime.seed(sessionID, entries)
    return entries
  }

  test("apply_patch update, then edit on the next turn", async () => {
    await using workspace = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "f.txt"), "one\ntwo\n"),
    })
    await Instance.provide({
      directory: workspace.path,
      fn: async () => {
        const file = path.join(workspace.path, "f.txt")
        await (await ReadTool.init()).execute({ filePath: file }, ctx)

        const patchText = `*** Begin Patch\n*** Update File: ${file}\n@@\n-one\n+1\n*** End Patch`
        const patched = await (await ApplyPatchTool.init()).execute({ patchText }, ctx)
        reseed(ctx.sessionID, [{ tool: "apply_patch", input: { patchText }, metadata: patched.metadata }])

        const edited = await (await EditTool.init()).execute({ filePath: file, oldString: "two", newString: "2" }, ctx)
        expect(edited.output).toContain("updated successfully")
        expect(await Bun.file(file).text()).toBe("1\n2\n")
      },
    })
  })

  test("apply_patch add, then edit the new file on the next turn", async () => {
    await using workspace = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "seed.txt"), "x"),
    })
    await Instance.provide({
      directory: workspace.path,
      fn: async () => {
        const file = path.join(workspace.path, "added.txt")
        const patchText = `*** Begin Patch\n*** Add File: ${file}\n+one\n+two\n*** End Patch`
        const patched = await (await ApplyPatchTool.init()).execute({ patchText }, ctx)
        expect(
          reseed(ctx.sessionID, [{ tool: "apply_patch", input: { patchText }, metadata: patched.metadata }]),
        ).toHaveLength(1)

        const edited = await (await EditTool.init()).execute({ filePath: file, oldString: "two", newString: "2" }, ctx)
        expect(edited.output).toContain("updated successfully")
      },
    })
  })

  test("apply_patch move, then edit at the destination on the next turn", async () => {
    await using workspace = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "old.txt"), "one\ntwo\n"),
    })
    await Instance.provide({
      directory: workspace.path,
      fn: async () => {
        const source = path.join(workspace.path, "old.txt")
        const destination = path.join(workspace.path, "new.txt")
        await (await ReadTool.init()).execute({ filePath: source }, ctx)

        const patchText = `*** Begin Patch\n*** Update File: ${source}\n*** Move to: ${destination}\n@@\n-one\n+1\n*** End Patch`
        const patched = await (await ApplyPatchTool.init()).execute({ patchText }, ctx)
        reseed(ctx.sessionID, [{ tool: "apply_patch", input: { patchText }, metadata: patched.metadata }])

        // The stamp must follow the file to its destination: the source path no
        // longer exists, so a stamp left on it would strand the moved file.
        const edited = await (
          await EditTool.init()
        ).execute({ filePath: destination, oldString: "two", newString: "2" }, ctx)
        expect(edited.output).toContain("updated successfully")
      },
    })
  })

  test("apply_patch touching several files stamps every one of them", async () => {
    await using workspace = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.txt"), "one\ntwo\n")
        await Bun.write(path.join(dir, "b.txt"), "three\nfour\n")
      },
    })
    await Instance.provide({
      directory: workspace.path,
      fn: async () => {
        const first = path.join(workspace.path, "a.txt")
        const second = path.join(workspace.path, "b.txt")
        const read = await ReadTool.init()
        await read.execute({ filePath: first }, ctx)
        await read.execute({ filePath: second }, ctx)

        const patchText = `*** Begin Patch\n*** Update File: ${first}\n@@\n-one\n+1\n*** Update File: ${second}\n@@\n-three\n+3\n*** End Patch`
        const patched = await (await ApplyPatchTool.init()).execute({ patchText }, ctx)
        // One filePath cannot describe a multi-file patch, so a per-file stamp
        // list is the only shape that survives the rebuild.
        expect(
          reseed(ctx.sessionID, [{ tool: "apply_patch", input: { patchText }, metadata: patched.metadata }]),
        ).toHaveLength(2)

        const edit = await EditTool.init()
        expect((await edit.execute({ filePath: first, oldString: "two", newString: "2" }, ctx)).output).toContain(
          "updated successfully",
        )
        expect((await edit.execute({ filePath: second, oldString: "four", newString: "4" }, ctx)).output).toContain(
          "updated successfully",
        )
      },
    })
  })

  test("concurrent edits to one file survive the next turn's rebuild", async () => {
    await using workspace = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "f.txt"), "one\ntwo\nthree\nfour\n"),
    })
    await Instance.provide({
      directory: workspace.path,
      fn: async () => {
        const file = path.join(workspace.path, "f.txt")
        await (await ReadTool.init()).execute({ filePath: file }, ctx)

        // The batch tool issues tool calls concurrently, so the write order is
        // not the call order the parts are stored in.
        const edit = await EditTool.init()
        const concurrent = await Promise.all([
          edit.execute({ filePath: file, oldString: "one", newString: "1" }, ctx),
          edit.execute({ filePath: file, oldString: "two", newString: "2" }, ctx),
          edit.execute({ filePath: file, oldString: "three", newString: "3" }, ctx),
        ])
        for (const result of concurrent) expect(result.output).toContain("updated successfully")
        expect(await Bun.file(file).text()).toBe("1\n2\n3\nfour\n")

        reseed(
          ctx.sessionID,
          concurrent.map((result) => ({ tool: "edit", input: { filePath: file }, metadata: result.metadata })),
        )
        const after = await edit.execute({ filePath: file, oldString: "four", newString: "4" }, ctx)
        expect(after.output).toContain("updated successfully")
      },
    })
  })

  test("write of a new file, then edit on the next turn", async () => {
    await using workspace = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "seed.txt"), "x"),
    })
    await Instance.provide({
      directory: workspace.path,
      fn: async () => {
        const file = path.join(workspace.path, "brand-new.txt")
        const written = await (await WriteTool.init()).execute({ filePath: file, content: "alpha\nbeta\n" }, ctx)
        reseed(ctx.sessionID, [{ tool: "write", input: { filePath: file }, metadata: written.metadata }])

        const edited = await (await EditTool.init()).execute({ filePath: file, oldString: "beta", newString: "B" }, ctx)
        expect(edited.output).toContain("updated successfully")
      },
    })
  })

  test("delete then recreate, then edit on the next turn", async () => {
    await using workspace = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "f.txt"), "one\ntwo\n"),
    })
    await Instance.provide({
      directory: workspace.path,
      fn: async () => {
        const file = path.join(workspace.path, "f.txt")
        await (await ReadTool.init()).execute({ filePath: file }, ctx)
        const patchText = `*** Begin Patch\n*** Delete File: ${file}\n*** End Patch`
        await (await ApplyPatchTool.init()).execute({ patchText }, ctx)

        const written = await (await WriteTool.init()).execute({ filePath: file, content: "alpha\nbeta\n" }, ctx)
        reseed(ctx.sessionID, [{ tool: "write", input: { filePath: file }, metadata: written.metadata }])

        const edited = await (await EditTool.init()).execute({ filePath: file, oldString: "beta", newString: "B" }, ctx)
        expect(edited.output).toContain("updated successfully")
      },
    })
  })
})

// A formatter subscribes to File.Event.Edited and rewrites the file in place, so
// every writing tool must publish that event and stamp afterwards. Stamping
// first records pre-format bytes and leaves the file newer than its own stamp.
describe("FileTime with a formatter rewriting after the write", () => {
  function formatter(marker: string) {
    return Bus.subscribe(FileEvents.Event.Edited, async (payload) => {
      const target = payload.properties.file
      const text = await Bun.file(target).text()
      if (text.includes(marker)) return
      await Bun.write(target, text + marker + "\n")
      // A real formatter also advances mtime; without this the mtime fast path
      // hides whether the stamp was taken before or after the rewrite.
      bumpMtime(target)
    })
  }

  test("edit, then edit again after the formatter rewrote the file", async () => {
    await using workspace = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "f.txt"), "one\ntwo\n"),
    })
    await Instance.provide({
      directory: workspace.path,
      fn: async () => {
        const file = path.join(workspace.path, "f.txt")
        await (await ReadTool.init()).execute({ filePath: file }, ctx)
        const unsubscribe = formatter("// formatted-edit")
        const edit = await EditTool.init()
        await edit.execute({ filePath: file, oldString: "one", newString: "1" }, ctx)
        const second = await edit.execute({ filePath: file, oldString: "two", newString: "2" }, ctx)
        unsubscribe()
        expect(second.output).toContain("updated successfully")
      },
    })
  })

  test("write, then edit after the formatter rewrote the file", async () => {
    await using workspace = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "seed.txt"), "x"),
    })
    await Instance.provide({
      directory: workspace.path,
      fn: async () => {
        const file = path.join(workspace.path, "w.txt")
        const unsubscribe = formatter("// formatted-write")
        await (await WriteTool.init()).execute({ filePath: file, content: "one\ntwo\n" }, ctx)
        const edited = await (await EditTool.init()).execute({ filePath: file, oldString: "two", newString: "2" }, ctx)
        unsubscribe()
        expect(edited.output).toContain("updated successfully")
      },
    })
  })

  test("apply_patch, then edit after the formatter rewrote the file", async () => {
    await using workspace = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "f.txt"), "one\ntwo\n"),
    })
    await Instance.provide({
      directory: workspace.path,
      fn: async () => {
        const file = path.join(workspace.path, "f.txt")
        await (await ReadTool.init()).execute({ filePath: file }, ctx)
        const unsubscribe = formatter("// formatted-patch")
        const patchText = `*** Begin Patch\n*** Update File: ${file}\n@@\n-one\n+1\n*** End Patch`
        await (await ApplyPatchTool.init()).execute({ patchText }, ctx)
        const edited = await (await EditTool.init()).execute({ filePath: file, oldString: "two", newString: "2" }, ctx)
        unsubscribe()
        expect(edited.output).toContain("updated successfully")
      },
    })
  })
})
