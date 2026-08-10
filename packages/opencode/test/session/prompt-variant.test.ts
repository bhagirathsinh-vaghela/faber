import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
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

  test("uses default model when no last message exists", async () => {
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

        // First prompt without model in fresh session - uses default model (not agent's)
        const first = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        if (first.info.role !== "user") throw new Error("expected user message")
        // lastModel() returns Provider.defaultModel() when no messages exist
        expect(first.info.model?.providerID).toBeDefined()
        expect(first.info.model?.modelID).toBeDefined()

        await Session.remove(session.id)
      },
    })
  })
})
