import { test, expect } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"

const COMPLETE = {
  name: "Claude Fable 5.1",
  family: "claude-fable",
  release_date: "2026-08-28",
  provider: { npm: "@ai-sdk/anthropic" },
  limit: { context: 1000000, output: 128000 },
  cost: { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
  reasoning: true,
  temperature: false,
  tool_call: true,
  attachment: true,
  modalities: { input: ["text", "image", "pdf"], output: ["text"] },
}

async function withConfig(model: Record<string, unknown>, fn: () => Promise<void>) {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: { anthropic: { models: { "claude-fable-5-1": model } } },
        }),
      )
    },
  })
  await Instance.provide({ directory: tmp.path, fn })
}

test("a complete config model entry builds without consulting models.dev", async () => {
  await withConfig(COMPLETE, async () => {
    const model = (await Provider.list())["anthropic"].models["claude-fable-5-1"]
    expect(model.name).toBe("Claude Fable 5.1")
    expect(model.family).toBe("claude-fable")
    expect(model.release_date).toBe("2026-08-28")
    expect(model.limit.context).toBe(1000000)
    expect(model.limit.output).toBe(128000)
    expect(model.cost.input).toBe(10)
    expect(model.cost.output).toBe(50)
    expect(model.cost.cache.read).toBe(1)
    expect(model.cost.cache.write).toBe(12.5)
    expect(model.capabilities.reasoning).toBe(true)
    expect(model.capabilities.temperature).toBe(false)
    expect(model.capabilities.toolcall).toBe(true)
    expect(model.capabilities.attachment).toBe(true)
    expect(model.capabilities.input.pdf).toBe(true)
    expect(model.capabilities.input.audio).toBe(false)
    expect(model.api.npm).toBe("@ai-sdk/anthropic")
  })
})

test("a config model entry missing one field throws instead of inheriting it", async () => {
  const partial = { ...COMPLETE }
  delete (partial as Record<string, unknown>).family
  await withConfig(partial, async () => {
    const err = await Provider.list().then(
      () => undefined,
      (e) => e,
    )
    expect(err).toBeInstanceOf(Provider.PartialModelConfigError)
    expect(err.data.providerID).toBe("anthropic")
    expect(err.data.modelID).toBe("claude-fable-5-1")
    expect(err.data.missing).toEqual(["family"])
  })
})

test("the error names every missing field, not just the first", async () => {
  const partial = { ...COMPLETE }
  delete (partial as Record<string, unknown>).release_date
  delete (partial as Record<string, unknown>).cost
  await withConfig(partial, async () => {
    const err = await Provider.list().then(
      () => undefined,
      (e) => e,
    )
    expect(err.data.missing).toEqual(["release_date", "cost"])
  })
})

test("a declared cost without cache rates prices the cache at zero", async () => {
  await withConfig({ ...COMPLETE, cost: { input: 1.75, output: 14 } }, async () => {
    const model = (await Provider.list())["anthropic"].models["claude-fable-5-1"]
    expect(model.cost.input).toBe(1.75)
    expect(model.cost.cache.read).toBe(0)
    expect(model.cost.cache.write).toBe(0)
  })
})
