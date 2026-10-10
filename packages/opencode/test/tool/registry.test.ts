import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { ToolRegistry } from "../../src/tool/registry"
import { Flag } from "../../src/flag/flag"

describe("tool.registry", () => {
  test("the opencode provider gets the Exa search tools only through OPENCODE_ENABLE_EXA", async () => {
    await using dir = await tmpdir()
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const ids = await ToolRegistry.tools({ providerID: "opencode", modelID: "claude-sonnet-4-5" }).then((tools) =>
          tools.map((tool) => tool.id),
        )
        expect([ids.includes("websearch"), ids.includes("codesearch")]).toEqual([
          Flag.OPENCODE_ENABLE_EXA,
          Flag.OPENCODE_ENABLE_EXA,
        ])
      },
    })
  })

  test("the edit family follows the model: a patch tool for GPT-5, the edit tools otherwise", async () => {
    await using workspace = await tmpdir()
    await Instance.provide({
      directory: workspace.path,
      fn: async () => {
        const family = async (providerID: string, modelID: string) =>
          (await ToolRegistry.tools({ providerID, modelID }))
            .map((tool) => tool.id)
            .filter((id) => ["apply_patch", "edit", "multiedit", "write"].includes(id))
        expect(await family("anthropic", "claude-opus-4-5")).toEqual(["edit", "multiedit", "write"])
        expect(await family("openai", "gpt-5")).toEqual(["apply_patch"])
      },
    })
  })

  test("loads tools from .opencode/tool (singular)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const opencodeDir = path.join(dir, ".opencode")
        await fs.mkdir(opencodeDir, { recursive: true })

        const toolDir = path.join(opencodeDir, "tool")
        await fs.mkdir(toolDir, { recursive: true })

        await Bun.write(
          path.join(toolDir, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("hello")
      },
    })
  })

  test("loads tools from .opencode/tools (plural)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const opencodeDir = path.join(dir, ".opencode")
        await fs.mkdir(opencodeDir, { recursive: true })

        const toolsDir = path.join(opencodeDir, "tools")
        await fs.mkdir(toolsDir, { recursive: true })

        await Bun.write(
          path.join(toolsDir, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("hello")
      },
    })
  })
})
