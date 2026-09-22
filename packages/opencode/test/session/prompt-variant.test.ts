import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { tmpdir } from "../fixture/fixture"

describe("session.prompt agent variant", () => {
  test("inherits model from last session message, falls back to agent model", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
            variant: "xhigh",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        // Explicit model wins; the agent's variant still applies
        const first = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: { providerID: "opencode", modelID: "kimi-k2.5-free" },
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        if (first.info.role !== "user") throw new Error("expected user message")
        expect(first.info.model).toEqual({ providerID: "opencode", modelID: "kimi-k2.5-free" })
        expect(first.info.variant).toBe("xhigh")

        // Second prompt without model - inherits from last message (not agent's model)
        const second = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "hello again" }],
        })
        if (second.info.role !== "user") throw new Error("expected user message")
        expect(second.info.model).toEqual({ providerID: "opencode", modelID: "kimi-k2.5-free" })
        expect(second.info.variant).toBe("xhigh")

        // Third prompt with explicit variant - uses it
        const third = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          variant: "high",
          parts: [{ type: "text", text: "hello third" }],
        })
        if (third.info.role !== "user") throw new Error("expected user message")
        expect(third.info.variant).toBe("high")

        await Session.remove(session.id)
      },
    })
  })

  test("resolves the agent's configured model on a fresh no-override send", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
            variant: "xhigh",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        // No explicit model and no prior turn, so resolution falls through
        // input.model and current.model to the build agent's configured model
        // (the provider default is only the last resort after agent.model).
        const first = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        if (first.info.role !== "user") throw new Error("expected user message")
        expect(first.info.model).toEqual({ providerID: "openai", modelID: "gpt-5.2" })

        await Session.remove(session.id)
      },
    })
  })
})

describe("session.prompt model default variant", () => {
  const COMPLETE = {
    name: "Model",
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

  function config(agent?: { variant?: string }) {
    return {
      model: "openai/gpt-5.2",
      agent: agent ? { build: agent } : undefined,
      provider: {
        openai: {
          options: { apiKey: "test-key" },
          models: {
            "gpt-5.2": { ...COMPLETE, name: "GPT-5.2", variant: "high" },
            "gpt-5.1": { ...COMPLETE, name: "GPT-5.1", variant: "low" },
          },
        },
      },
    }
  }

  async function send(sessionID: string, input: Partial<SessionPrompt.PromptInput> = {}) {
    const message = await SessionPrompt.prompt({
      sessionID,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
      ...input,
    })
    if (message.info.role !== "user") throw new Error("expected user message")
    return message.info
  }

  test("a send that names no variant runs with the model's default", async () => {
    await using tmp = await tmpdir({ git: true, config: config() })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const first = await send(session.id)
        expect(first.model).toEqual({ providerID: "openai", modelID: "gpt-5.2" })
        expect(first.variant).toBe("high")
        await Session.remove(session.id)
      },
    })
  })

  test("switching models takes the new model's default, not the old model's variant", async () => {
    await using tmp = await tmpdir({ git: true, config: config() })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        expect((await send(session.id)).variant).toBe("high")
        const switched = await send(session.id, { model: { providerID: "openai", modelID: "gpt-5.1" } })
        expect(switched.variant).toBe("low")
        await Session.remove(session.id)
      },
    })
  })

  test("an explicit pick wins and sticks while the model is unchanged", async () => {
    await using tmp = await tmpdir({ git: true, config: config() })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        expect((await send(session.id, { variant: "medium" })).variant).toBe("medium")
        expect((await send(session.id)).variant).toBe("medium")
        await Session.remove(session.id)
      },
    })
  })

  test("an agent variant overrides the model default", async () => {
    await using tmp = await tmpdir({ git: true, config: config({ variant: "medium" }) })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        expect((await send(session.id)).variant).toBe("medium")
        await Session.remove(session.id)
      },
    })
  })
})

describe("session.prompt variant inheritance through synthetic turns", () => {
  async function synthetic(sessionID: string) {
    const message: MessageV2.User = {
      id: Identifier.ascending("message"),
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "plan",
      model: { providerID: "openai", modelID: "gpt-5.2" },
      synthetic: true,
    }
    await Session.updateMessage(message)
    return message
  }

  test("a turn after a synthetic tail inherits the session's variant, not the agent default", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: { agent: { build: { model: "openai/gpt-5.2", variant: "xhigh" } } },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          variant: "high",
          parts: [{ type: "text", text: "switch to high" }],
        })

        await synthetic(session.id)

        expect(await MessageV2.lastVariant(session.id)).toBe("high")

        const next = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "after the synthetic turn" }],
        })
        if (next.info.role !== "user") throw new Error("expected user message")
        expect(next.info.variant).toBe("high")

        await Session.remove(session.id)
      },
    })
  })
})
