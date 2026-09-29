import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const MODEL = {
  name: "GPT-5.2",
  family: "gpt",
  release_date: "2025-01-01",
  attachment: false,
  reasoning: true,
  temperature: false,
  tool_call: true,
  cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
  limit: { context: 400000, output: 128000 },
  modalities: { input: ["text" as const], output: ["text" as const] },
  variant: "effort-medium",
  variants: { "effort-low": {}, "effort-medium": {} },
}

const config = (agent?: Record<string, { variant: string }>) => ({
  model: "openai/gpt-5.2",
  provider: { openai: { options: { apiKey: "test-key" }, models: { "gpt-5.2": MODEL } } },
  ...(agent ? { agent } : {}),
})

async function resolve(agent?: Record<string, { variant: string }>) {
  await using project = await tmpdir({ git: true, config: config(agent) })
  return Instance.provide({
    directory: project.path,
    fn: async () => {
      const response = await Server.App().request(`/provider/default?directory=${encodeURIComponent(project.path)}`)
      return { body: await response.json() }
    },
  })
}

test("GET /provider/default returns the model's configured variant", async () => {
  const resolved = await resolve()
  expect(resolved.body).toEqual({ providerID: "openai", modelID: "gpt-5.2", variant: "effort-medium", agent: "build" })
})

test("GET /provider/default returns the default agent's variant over the model's", async () => {
  const resolved = await resolve({ build: { variant: "effort-low" } })
  expect(resolved.body).toEqual({ providerID: "openai", modelID: "gpt-5.2", variant: "effort-low", agent: "build" })
})
