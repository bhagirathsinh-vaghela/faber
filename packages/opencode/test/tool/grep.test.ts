import { describe, expect, test } from "bun:test"
import path from "path"
import { GrepTool } from "../../src/tool/grep"
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

const projectRoot = path.join(__dirname, "../..")

async function createFixture() {
  return tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "a.ts"), "export const foo = 1\nexport const bar = 2\n")
      await Bun.write(path.join(dir, "b.ts"), "export const baz = 3\n")
      await Bun.write(path.join(dir, "c.py"), "def hello():\n    pass\n")
    },
  })
}

describe("tool.grep", () => {
  test("basic search (default files_with_matches mode)", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const grep = await GrepTool.init()
        const result = await grep.execute(
          {
            pattern: "export",
            path: path.join(projectRoot, "src/tool"),
            include: "*.ts",
          },
          ctx,
        )
        expect(result.metadata.matches).toBeGreaterThan(0)
        expect(result.output).toContain("Found")
        expect(result.output).toContain("file(s)")
      },
    })
  })

  test("no matches returns correct output", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "test.txt"), "hello world")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await GrepTool.init()
        const result = await grep.execute(
          {
            pattern: "xyznonexistentpatternxyz123",
            path: tmp.path,
          },
          ctx,
        )
        expect(result.metadata.matches).toBe(0)
        expect(result.output).toBe("No files found")
      },
    })
  })

  test("handles CRLF line endings in output", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "test.txt"), "line1\nline2\nline3")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await GrepTool.init()
        const result = await grep.execute(
          {
            pattern: "line",
            path: tmp.path,
          },
          ctx,
        )
        expect(result.metadata.matches).toBeGreaterThan(0)
      },
    })
  })

  test("output_mode content returns matching lines", async () => {
    await using tmp = await createFixture()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await GrepTool.init()
        const result = await grep.execute(
          {
            pattern: "export",
            path: tmp.path,
            output_mode: "content",
          },
          ctx,
        )
        expect(result.output).toContain("export const foo")
        expect(result.output).toContain("export const bar")
        expect(result.output).toContain("export const baz")
      },
    })
  })

  test("output_mode content with context lines", async () => {
    await using tmp = await createFixture()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await GrepTool.init()
        const result = await grep.execute(
          {
            pattern: "foo",
            path: tmp.path,
            output_mode: "content",
            context: 1,
          },
          ctx,
        )
        // Context should include the bar line after foo
        expect(result.output).toContain("export const foo")
        expect(result.output).toContain("export const bar")
      },
    })
  })

  test("output_mode count returns per-file counts", async () => {
    await using tmp = await createFixture()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await GrepTool.init()
        const result = await grep.execute(
          {
            pattern: "export",
            path: tmp.path,
            output_mode: "count",
          },
          ctx,
        )
        expect(result.output).toContain("a.ts:2")
        expect(result.output).toContain("b.ts:1")
        expect(result.output).toContain("Found 3 total occurrences across 2 files.")
      },
    })
  })

  test("case_insensitive flag", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "test.txt"), "Hello World\nhello world\nHELLO WORLD\n")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await GrepTool.init()
        const sensitive = await grep.execute(
          {
            pattern: "hello",
            path: tmp.path,
            output_mode: "count",
          },
          ctx,
        )
        const insensitive = await grep.execute(
          {
            pattern: "hello",
            path: tmp.path,
            output_mode: "count",
            case_insensitive: true,
          },
          ctx,
        )
        expect(sensitive.output).toContain("1")
        expect(insensitive.output).toContain("3")
      },
    })
  })

  test("type filter", async () => {
    await using tmp = await createFixture()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await GrepTool.init()
        const result = await grep.execute(
          {
            pattern: "def|export",
            path: tmp.path,
            type: "py",
          },
          ctx,
        )
        // Should only find the python file
        expect(result.metadata.matches).toBe(1)
        expect(result.output).toContain("c.py")
        expect(result.output).not.toContain("a.ts")
      },
    })
  })

  test("head_limit and offset", async () => {
    await using tmp = await createFixture()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await GrepTool.init()
        // Get all files first
        const all = await grep.execute(
          {
            pattern: "export",
            path: tmp.path,
          },
          ctx,
        )
        expect(all.metadata.matches).toBe(2) // a.ts and b.ts

        // With head_limit=1, should only get 1 file
        const limited = await grep.execute(
          {
            pattern: "export",
            path: tmp.path,
            head_limit: 1,
          },
          ctx,
        )
        expect(limited.metadata.matches).toBe(1)

        // With offset=1, head_limit=1
        const paged = await grep.execute(
          {
            pattern: "export",
            path: tmp.path,
            offset: 1,
            head_limit: 1,
          },
          ctx,
        )
        expect(paged.metadata.matches).toBe(1)
      },
    })
  })

  test("multiline matching", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "test.txt"), "start\nmiddle\nend\n")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await GrepTool.init()
        const result = await grep.execute(
          {
            pattern: "start.*end",
            path: tmp.path,
            output_mode: "content",
            multiline: true,
          },
          ctx,
        )
        expect(result.output).toContain("start")
        expect(result.output).toContain("end")
      },
    })
  })

  test("excludes .git directories", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "real.txt"), "findme\n")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await GrepTool.init()
        const result = await grep.execute(
          {
            pattern: "findme",
            path: tmp.path,
          },
          ctx,
        )
        // Should find real.txt but not anything in .git
        expect(result.metadata.matches).toBe(1)
        expect(result.output).toContain("real.txt")
        expect(result.output).not.toContain(".git")
      },
    })
  })

  test("content mode keeps the matched text verbatim", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.txt"), "x = a // b/../c\n")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await GrepTool.init()
        const result = await grep.execute({ pattern: "x =", path: tmp.path, output_mode: "content" }, ctx)
        expect(result.output).toBe("a.txt:1:x = a // b/../c")
      },
    })
  })

  test("count mode on a single file keeps the file name", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.txt"), "foo\nfoo\nbar\n")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await GrepTool.init()
        const result = await grep.execute(
          { pattern: "foo", path: path.join(tmp.path, "a.txt"), output_mode: "count" },
          ctx,
        )
        expect(result.output.split("\n")[0]).toBe("a.txt:2")
      },
    })
  })

  test("content mode relativizes paths", async () => {
    await using tmp = await createFixture()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await GrepTool.init()
        const result = await grep.execute(
          {
            pattern: "foo",
            path: tmp.path,
            output_mode: "content",
          },
          ctx,
        )
        // Output should use relative paths, not absolute
        expect(result.output).not.toContain(tmp.path)
        expect(result.output).toContain("a.ts")
      },
    })
  })
})

describe("CRLF regex handling", () => {
  test("regex correctly splits Unix line endings", () => {
    const unixOutput = "file1.txt|1|content1\nfile2.txt|2|content2\nfile3.txt|3|content3"
    const lines = unixOutput.trim().split(/\r?\n/)
    expect(lines.length).toBe(3)
    expect(lines[0]).toBe("file1.txt|1|content1")
    expect(lines[2]).toBe("file3.txt|3|content3")
  })

  test("regex correctly splits Windows CRLF line endings", () => {
    const windowsOutput = "file1.txt|1|content1\r\nfile2.txt|2|content2\r\nfile3.txt|3|content3"
    const lines = windowsOutput.trim().split(/\r?\n/)
    expect(lines.length).toBe(3)
    expect(lines[0]).toBe("file1.txt|1|content1")
    expect(lines[2]).toBe("file3.txt|3|content3")
  })

  test("regex handles mixed line endings", () => {
    const mixedOutput = "file1.txt|1|content1\nfile2.txt|2|content2\r\nfile3.txt|3|content3"
    const lines = mixedOutput.trim().split(/\r?\n/)
    expect(lines.length).toBe(3)
  })
})
