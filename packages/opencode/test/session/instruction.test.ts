import { describe, expect, test } from "bun:test"
import path from "path"
import { InstructionPrompt } from "../../src/session/instruction"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("InstructionPrompt.system path headers", () => {
  test("global header is home-relative from any worktree", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, ".claude", "CLAUDE.md"), "# Global")
        for (const name of ["alpha", "beta"]) {
          await Bun.write(path.join(dir, "projects", name, "AGENTS.md"), "# Project")
        }
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      const globals = async (directory: string) =>
        Instance.provide({ directory, fn: async () => (await InstructionPrompt.system()).global })

      const alpha = await globals(path.join(tmp.path, "projects", "alpha"))
      const beta = await globals(path.join(tmp.path, "projects", "beta"))
      const atHome = await globals(tmp.path)

      expect(alpha[0]).toContain("Instructions from: ~/.claude/CLAUDE.md")
      expect(beta).toEqual(alpha)
      expect(atHome).toEqual(alpha)
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("project header stays relative to the worktree", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Project")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const instructions = await InstructionPrompt.system()
        expect(instructions.project[0]).toContain("Instructions from: AGENTS.md")
      },
    })
  })
})

describe("AGENTS.local.md", () => {
  test("is read alongside CLAUDE.md instead of shadowing it", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "CLAUDE.md"), "# Claude")
        await Bun.write(path.join(dir, "AGENTS.local.md"), "# Local")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const instructions = await InstructionPrompt.system()
        expect(instructions.project).toEqual([
          "Instructions from: CLAUDE.md\n# Claude",
          "Instructions from: AGENTS.local.md\n# Local",
        ])
      },
    })
  })

  test("is read alongside AGENTS.md", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Project")
        await Bun.write(path.join(dir, "CLAUDE.md"), "# Claude")
        await Bun.write(path.join(dir, "AGENTS.local.md"), "# Local")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const instructions = await InstructionPrompt.system()
        expect(instructions.project).toEqual([
          "Instructions from: AGENTS.md\n# Project",
          "Instructions from: AGENTS.local.md\n# Local",
        ])
      },
    })
  })

  test("is read from a global config dir alongside the global winner", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, ".claude", "CLAUDE.md"), "# Global")
        await Bun.write(path.join(dir, "config", "AGENTS.local.md"), "# Global Local")
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    const configdir = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_TEST_HOME = tmp.path
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp.path, "config")

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const instructions = await InstructionPrompt.system()
          expect(instructions.global).toEqual([
            "Instructions from: ~/.claude/CLAUDE.md\n# Global",
            "Instructions from: ~/config/AGENTS.local.md\n# Global Local",
          ])
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
      if (configdir) process.env.OPENCODE_CONFIG_DIR = configdir
      else delete process.env.OPENCODE_CONFIG_DIR
    }
  })

  test("loads once, as global, when the project is the global config dir", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "config", "AGENTS.local.md"), "# Global Local")
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    const configdir = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_TEST_HOME = tmp.path
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp.path, "config")

    try {
      await Instance.provide({
        directory: path.join(tmp.path, "config"),
        fn: async () => {
          const instructions = await InstructionPrompt.system()
          expect(instructions.global).toEqual(["Instructions from: ~/config/AGENTS.local.md\n# Global Local"])
          expect(instructions.project).toEqual([])
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
      if (configdir) process.env.OPENCODE_CONFIG_DIR = configdir
      else delete process.env.OPENCODE_CONFIG_DIR
    }
  })

  test("is picked up from a subdirectory next to that dir's AGENTS.md", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "subdir", "AGENTS.md"), "# Subdir")
        await Bun.write(path.join(dir, "subdir", "AGENTS.local.md"), "# Subdir Local")
        await Bun.write(path.join(dir, "subdir", "nested", "file.ts"), "const x = 1")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const results = await InstructionPrompt.resolve(
          [],
          path.join(tmp.path, "subdir", "nested", "file.ts"),
          "test-message-local",
        )
        expect(results.map((x) => x.filepath)).toEqual([
          path.join(tmp.path, "subdir", "AGENTS.md"),
          path.join(tmp.path, "subdir", "AGENTS.local.md"),
        ])
      },
    })
  })
})

describe("InstructionPrompt.resolve", () => {
  test("returns empty when AGENTS.md is at project root (already in systemPaths)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Root Instructions")
        await Bun.write(path.join(dir, "src", "file.ts"), "const x = 1")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const system = await InstructionPrompt.systemPaths()
        expect(system.has(path.join(tmp.path, "AGENTS.md"))).toBe(true)

        const results = await InstructionPrompt.resolve([], path.join(tmp.path, "src", "file.ts"), "test-message-1")
        expect(results).toEqual([])
      },
    })
  })

  test("returns AGENTS.md from subdirectory (not in systemPaths)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "subdir", "AGENTS.md"), "# Subdir Instructions")
        await Bun.write(path.join(dir, "subdir", "nested", "file.ts"), "const x = 1")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const system = await InstructionPrompt.systemPaths()
        expect(system.has(path.join(tmp.path, "subdir", "AGENTS.md"))).toBe(false)

        const results = await InstructionPrompt.resolve(
          [],
          path.join(tmp.path, "subdir", "nested", "file.ts"),
          "test-message-2",
        )
        expect(results.length).toBe(1)
        expect(results[0].filepath).toBe(path.join(tmp.path, "subdir", "AGENTS.md"))
      },
    })
  })

  test("doesn't reload AGENTS.md when reading it directly", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "subdir", "AGENTS.md"), "# Subdir Instructions")
        await Bun.write(path.join(dir, "subdir", "nested", "file.ts"), "const x = 1")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const filepath = path.join(tmp.path, "subdir", "AGENTS.md")
        const system = await InstructionPrompt.systemPaths()
        expect(system.has(filepath)).toBe(false)

        const results = await InstructionPrompt.resolve([], filepath, "test-message-2")
        expect(results).toEqual([])
      },
    })
  })
})
