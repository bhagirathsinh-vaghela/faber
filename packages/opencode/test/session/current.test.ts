import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { tmpdir } from "../fixture/fixture"

const MODEL = { providerID: "anthropic", modelID: "claude-x" }

describe("session.current — the persistent per-turn parameters", () => {
  test("a real send with an override writes session.current", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: MODEL,
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        const after = await Session.get(session.id)
        expect(after.current?.model).toEqual(MODEL)
        expect(after.current?.agent).toBe("build")
        await Session.remove(session.id)
      },
    })
  })

  test("a synthetic mint inherits session.current, not the request", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: MODEL,
          noReply: true,
          parts: [{ type: "text", text: "establish" }],
        })
        const messages = await Session.messages({ sessionID: session.id })
        const params = await MessageV2.currentParams(session.id, messages)
        expect(params.model).toEqual(MODEL)
        expect(params.agent).toBe("build")
        await Session.remove(session.id)
      },
    })
  })

  test("a synthetic mint does not overwrite current, even to a different agent", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        // Establish current as a non-default agent.
        await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "plan",
          model: MODEL,
          noReply: true,
          parts: [{ type: "text", text: "plan this" }],
        })
        expect((await Session.get(session.id)).current?.agent).toBe("plan")

        // A synthetic-only send (a resume prompt / delivered result) carries no
        // params. It must not rewrite current.agent to the resolved default.
        await SessionPrompt.prompt({
          sessionID: session.id,
          noReply: true,
          parts: [{ type: "text", text: "continue", synthetic: true }],
        })
        expect((await Session.get(session.id)).current?.agent).toBe("plan")
        await Session.remove(session.id)
      },
    })
  })

  test("a spawned session inherits current from its spawner at create", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const spawner = await Session.create({})
        await SessionPrompt.prompt({
          sessionID: spawner.id,
          agent: "build",
          model: MODEL,
          noReply: true,
          parts: [{ type: "text", text: "establish" }],
        })

        const helper = await Session.create({ spawnedBy: spawner.id })
        expect(helper.current?.model).toEqual(MODEL)
        expect(helper.current?.agent).toBe("build")

        await Session.remove(helper.id)
        await Session.remove(spawner.id)
      },
    })
  })

  test("a send with no override persists the resolved default model", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sent = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "no override" }],
        })
        if (sent.info.role !== "user") throw new Error("expected user message")
        const after = await Session.get(session.id)
        expect(after.current?.model).toEqual(sent.info.model)
        await Session.remove(session.id)
      },
    })
  })
})
