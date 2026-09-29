import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Provider } from "../../src/provider/provider"
import { tmpdir } from "../fixture/fixture"

const COMPLETE = {
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
}

const CONFIG = {
  model: "openai/gpt-5.2",
  provider: { openai: { options: { apiKey: "test-key" }, models: { "gpt-5.2": { ...COMPLETE, variant: "high" } } } },
}

const model = { providerID: "openai", modelID: "gpt-5.2" }

async function write(sessionID: string, choice: Pick<SessionPrompt.Launch, "model" | "variant">) {
  const message = await SessionPrompt.prompt({
    sessionID,
    agent: "build",
    noReply: true,
    parts: [{ type: "text", text: "hello" }],
    ...choice,
  })
  if (message.info.role !== "user") throw new Error(`expected a user message in ${sessionID}`)
  return message.info
}

async function withSession(
  fn: (sessionID: string) => Promise<void>,
  config: object = CONFIG,
  current?: Session.Info["current"],
) {
  await using project = await tmpdir({ git: true, config })
  await Instance.provide({
    directory: project.path,
    fn: async () => {
      const session = await Session.createNext({ directory: project.path, current })
      await fn(session.id)
      await Session.remove(session.id)
    },
  })
}

test("inherit writes the variant the session's last message ran on the same model", async () => {
  await withSession(async (sessionID) => {
    await write(sessionID, { model, variant: "medium" })
    const inherited = await write(sessionID, { model: Provider.INHERIT, variant: Provider.INHERIT })
    expect(inherited.model).toEqual(model)
    expect(inherited.variant).toBe("medium")
  })
})

test("default writes the model's configured variant even when the session's current differs", async () => {
  await withSession(async (sessionID) => {
    await write(sessionID, { model, variant: "medium" })
    const fresh = await write(sessionID, { model: Provider.DEFAULT, variant: Provider.DEFAULT })
    expect(fresh.model).toEqual(model)
    expect(fresh.variant).toBe("high")
  })
})

test("a concrete variant the model does not offer is rejected", async () => {
  await withSession(async (sessionID) => {
    await expect(write(sessionID, { model, variant: "bogus" })).rejects.toThrow(
      'model openai/gpt-5.2 offers no variant "bogus"',
    )
  })
})

const PLAIN = { ...COMPLETE, name: "GPT-4.1", reasoning: false }

const AGENT_VARIANT = {
  model: "openai/gpt-5.2",
  agent: { build: { variant: "medium" } },
  provider: {
    openai: {
      options: { apiKey: "test-key" },
      models: { "gpt-5.2": { ...COMPLETE, variant: "high" }, "gpt-4.1": PLAIN },
    },
  },
}

test("default takes the agent's variant on a model that offers it", async () => {
  await withSession(async (sessionID) => {
    const written = await write(sessionID, { model: Provider.DEFAULT, variant: Provider.DEFAULT })
    expect(written.model).toEqual(model)
    expect(written.variant).toBe("medium")
  }, AGENT_VARIANT)
})

test("default skips the agent's variant on a model that does not offer it", async () => {
  await withSession(async (sessionID) => {
    const plain = { providerID: "openai", modelID: "gpt-4.1" }
    const written = await write(sessionID, { model: plain, variant: Provider.DEFAULT })
    expect(written.model).toEqual(plain)
    expect(written.variant).toBeUndefined()
    expect((await SessionPrompt.defaults(undefined, plain)).variant).toBeUndefined()
  }, AGENT_VARIANT)
})

test("inherit falls through to the default when the session's model is no longer configured", async () => {
  await withSession(
    async (sessionID) => {
      const written = await write(sessionID, { model: Provider.INHERIT, variant: Provider.INHERIT })
      expect(written.model).toEqual(model)
      expect(written.variant).toBe("high")
    },
    CONFIG,
    { agent: "build", model: { providerID: "openai", modelID: "gpt-retired" }, variant: "low" },
  )
})

test("inherit falls through to the default when the session's provider is no longer configured", async () => {
  await withSession(
    async (sessionID) => {
      const written = await write(sessionID, { model: Provider.INHERIT, variant: Provider.INHERIT })
      expect(written.model).toEqual(model)
      expect(written.variant).toBe("high")
    },
    CONFIG,
    { agent: "build", model: { providerID: "retired-provider", modelID: "gpt-5.2" }, variant: "low" },
  )
})
