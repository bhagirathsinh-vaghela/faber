import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import type { PermissionNext } from "../../src/permission/next"
import type { Tool } from "../../src/tool/tool"
import { Instance } from "../../src/project/instance"
import { SkillTool } from "../../src/tool/skill"
import { Session } from "../../src/session"
import { Coverage } from "../../src/session/coverage"
import { tmpdir } from "../fixture/fixture"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
}

const SKILL_MD = (name: string) =>
  ["---", `name: ${name}`, `description: Skill ${name}.`, "---", "", `# ${name}`, ""].join("\n")

describe("tool.skill", () => {
  test("loading a reminder skill makes it active and records the content fingerprint", async () => {
    await using repo = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".opencode", "skill", "loop-skill", "SKILL.md"),
          [
            "---",
            "name: loop-skill",
            "description: Skill loop-skill.",
            "reminder:",
            "  sparse: keep going",
            "---",
            "",
            "# loop-skill",
            "",
          ].join("\n"),
        )
        await Bun.write(path.join(dir, "a.ts"), "one")
      },
    })
    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = repo.path
    try {
      await Instance.provide({
        directory: repo.path,
        fn: async () => {
          const session = await Session.create({})
          const tool = await SkillTool.init()
          await tool.execute({ name: "loop-skill" }, { ...baseCtx, sessionID: session.id, ask: async () => {} })
          const stored = await Session.get(session.id)
          expect(stored.activeSkills).toEqual(["loop-skill"])
          expect(stored.loaded).toBe(await Coverage.fingerprint(session.id))
          await Session.remove(session.id)
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("description renders a home skill location home-relative", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, ".opencode", "skill", "tool-skill", "SKILL.md"), SKILL_MD("tool-skill"))
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await SkillTool.init()
          expect(tool.description).toContain("<location>~/.opencode/skill/tool-skill/SKILL.md</location>")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  // The location text ships inside tools[], which Anthropic hashes ahead of the
  // system prompt, so an unchanged skill set must serialize byte-identically no
  // matter which directory the session runs in — otherwise the whole downstream
  // prompt cache misses.
  test("description is byte-identical across worktrees for one skill set", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, ".opencode", "skill", "global-skill", "SKILL.md"), SKILL_MD("global-skill"))
        for (const name of ["alpha", "beta"]) {
          const repo = path.join(dir, "projects", name)
          await fs.mkdir(repo, { recursive: true })
          await $`git init`.cwd(repo).quiet()
          await $`git commit --allow-empty -m init`.cwd(repo).quiet()
        }
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      const render = (directory: string) =>
        Instance.provide({ directory, fn: async () => (await SkillTool.init()).description })

      const alpha = await render(path.join(tmp.path, "projects", "alpha"))
      const beta = await render(path.join(tmp.path, "projects", "beta"))
      const atHome = await render(tmp.path)

      expect(alpha).toContain("<location>~/.opencode/skill/global-skill/SKILL.md</location>")
      expect(beta).toBe(alpha)
      expect(atHome).toBe(alpha)
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("execute returns skill content block with files", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".opencode", "skill", "tool-skill")
        await Bun.write(path.join(skillDir, "SKILL.md"), SKILL_MD("tool-skill"))
        await Bun.write(path.join(skillDir, "scripts", "demo.txt"), "demo")
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await SkillTool.init()
          const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
          const ctx: Tool.Context = {
            ...baseCtx,
            ask: async (req) => {
              requests.push(req)
            },
          }

          const result = await tool.execute({ name: "tool-skill" }, ctx)
          const dir = path.join(tmp.path, ".opencode", "skill", "tool-skill")
          const file = path.resolve(dir, "scripts", "demo.txt")

          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("skill")
          expect(requests[0].patterns).toContain("tool-skill")
          expect(requests[0].always).toContain("tool-skill")

          expect(result.metadata.dir).toBe(dir)
          expect(result.output).toContain(`<skill_content name="tool-skill">`)
          expect(result.output).toContain(`Base directory for this skill: ${pathToFileURL(dir).href}`)
          expect(result.output).toContain(`<file>${file}</file>`)
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })
})
