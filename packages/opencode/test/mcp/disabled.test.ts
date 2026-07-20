import { test, expect } from "bun:test"
import { MCP } from "../../src/mcp/index"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

// MCP.isDisabled is the execution-gate counterpart to corpus()'s catalog
// filter: both consult the server's `disabled` config. isDisabled keys off the
// derived toolKey the model actually calls, so these assert the toolKey mapping
// (including the self-namespacing dedupe) end to end against real config.
async function withConfig<T>(mcp: unknown, fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(`${dir}/opencode.json`, JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp }))
    },
  })
  return Instance.provide({ directory: tmp.path, fn })
}

test("isDisabled true for a tool listed in its server's disabled array", async () => {
  await withConfig(
    { everything: { type: "local", command: ["noop"], disabled: ["echo"] } },
    async () => {
      expect(await MCP.isDisabled("everything_echo")).toBe(true)
    },
  )
})

test("isDisabled false for a tool not in the disabled array", async () => {
  await withConfig(
    { everything: { type: "local", command: ["noop"], disabled: ["echo"] } },
    async () => {
      expect(await MCP.isDisabled("everything_add")).toBe(false)
    },
  )
})

test("isDisabled false when the server has no disabled array", async () => {
  await withConfig({ everything: { type: "local", command: ["noop"] } }, async () => {
    expect(await MCP.isDisabled("everything_echo")).toBe(false)
  })
})

test("isDisabled false when there is no MCP config at all", async () => {
  await withConfig({}, async () => {
    expect(await MCP.isDisabled("everything_echo")).toBe(false)
  })
})

test("isDisabled matches through toolKey self-namespace dedupe", async () => {
  // datadog self-prefixes its tools (datadog_aggregate_logs); the disabled
  // entry uses the native name, and toolKey strips the redundant prefix, so the
  // key the model calls (datadog_aggregate_logs) must still resolve as disabled.
  await withConfig(
    { datadog: { type: "local", command: ["noop"], disabled: ["datadog_aggregate_logs"] } },
    async () => {
      expect(await MCP.isDisabled("datadog_aggregate_logs")).toBe(true)
    },
  )
})
