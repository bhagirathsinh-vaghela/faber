import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionPin } from "../../src/session/pin"
import { MessageV2 } from "../../src/session/message-v2"
import { Provider } from "../../src/provider/provider"
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
          variant: Provider.DEFAULT,
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

  test("a delivered message inherits the session's established agent and model", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const real = await Provider.defaultModel()
        const session = await Session.create({})
        await SessionPrompt.prompt({
          variant: Provider.DEFAULT,
          sessionID: session.id,
          agent: "plan",
          model: real,
          noReply: true,
          parts: [{ type: "text", text: "establish" }],
        })
        const delivered = await SessionPrompt.deliver({
          model: Provider.INHERIT,
          variant: Provider.INHERIT,
          sessionID: session.id,
          parts: [{ type: "text", text: "job done", synthetic: true }],
          claim: () => true,
          wake: false,
        })
        if (delivered?.info.role !== "user") throw new Error("expected a delivered user message")
        expect([delivered.info.agent, delivered.info.model, delivered.info.synthetic]).toEqual(["plan", real, true])
        expect((await Session.get(session.id)).current?.agent).toBe("plan")
        await Session.remove(session.id)
      },
    })
  })

  test("a delivery whose claim is lost writes nothing", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const delivered = await SessionPrompt.deliver({
          model: Provider.DEFAULT,
          variant: Provider.DEFAULT,
          sessionID: session.id,
          parts: [{ type: "text", text: "already paid", synthetic: true }],
          claim: () => false,
        })
        expect(delivered).toBeUndefined()
        expect(await Session.messages({ sessionID: session.id })).toEqual([])
        await Session.remove(session.id)
      },
    })
  })

  test("model() falls back when current.model names a dropped model (plan/shell mint path)", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        // MODEL does not resolve against the provider. A plan/shell mint stamps
        // MessageV2.model(); if it forwarded the dropped model, the next loop's
        // getModel would throw and abort the turn. It must fall back instead.
        await SessionPrompt.prompt({
          variant: Provider.DEFAULT,
          sessionID: session.id,
          agent: "build",
          model: MODEL,
          noReply: true,
          parts: [{ type: "text", text: "establish" }],
        })
        const resolved = await MessageV2.model(session.id)
        expect(resolved).toEqual(await Provider.defaultModel())
        expect(resolved).not.toEqual(MODEL)
        await Session.remove(session.id)
      },
    })
  })

  test("a resume prompt (synthetic, no agent) runs as the session's established agent", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await SessionPrompt.prompt({
          variant: Provider.DEFAULT,
          sessionID: session.id,
          agent: "plan",
          model: MODEL,
          noReply: true,
          parts: [{ type: "text", text: "plan this" }],
        })

        // Exactly what serve.ts sends on restart-resume: synthetic, no agent.
        const resumed = await SessionPrompt.prompt({
          model: Provider.INHERIT,
          variant: Provider.INHERIT,
          sessionID: session.id,
          noReply: true,
          parts: [{ type: "text", text: "continue", synthetic: true }],
        })
        if (resumed.info.role !== "user") throw new Error("expected user message")
        expect(resumed.info.agent).toBe("plan")
        await Session.remove(session.id)
      },
    })
  })

  test("resolveAgent falls back to a real agent for a dropped name, resolves a valid one", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const snapshot = await SessionPin.get(session.id)

        // A valid name resolves to that agent.
        expect((await SessionPrompt.resolveAgent("build", snapshot)).name).toBe("build")
        // A dropped name and an absent name both fall through to the configured
        // default (build here), never undefined — dereferencing agent.name/.model/
        // .steps at the call sites must not throw.
        expect((await SessionPrompt.resolveAgent("ghost-agent-xyz", snapshot)).name).toBe("build")
        expect((await SessionPrompt.resolveAgent(undefined, snapshot)).name).toBe("build")

        await Session.remove(session.id)
      },
    })
  })

  test("a send falls back to a real agent when current.agent names a dropped agent", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await SessionPrompt.prompt({
          variant: Provider.DEFAULT,
          sessionID: session.id,
          agent: "build",
          model: MODEL,
          noReply: true,
          parts: [{ type: "text", text: "establish" }],
        })
        // Config dropped the established agent after it was persisted: current
        // now names an agent that no longer resolves. A no-agent send must fall
        // through to the default, not throw on `agent.name`.
        await Session.update(session.id, (draft) => {
          draft.current!.agent = "ghost-agent-that-does-not-exist"
        })
        const resumed = await SessionPrompt.prompt({
          model: Provider.INHERIT,
          variant: Provider.INHERIT,
          sessionID: session.id,
          noReply: true,
          parts: [{ type: "text", text: "continue", synthetic: true }],
        })
        if (resumed.info.role !== "user") throw new Error("expected user message")
        expect(resumed.info.agent).toBe("build")
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
          variant: Provider.DEFAULT,
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
          model: Provider.INHERIT,
          variant: Provider.INHERIT,
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
          variant: Provider.DEFAULT,
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

  test("setAgent switches current.agent, preserving model/variant", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await SessionPrompt.prompt({
          variant: Provider.DEFAULT,
          sessionID: session.id,
          agent: "build",
          model: MODEL,
          noReply: true,
          parts: [{ type: "text", text: "establish" }],
        })
        const before = (await Session.get(session.id)).current

        // What plan_enter/plan_exit do on a mode switch: only the agent moves.
        await Session.setAgent(session.id, "plan")
        const after = (await Session.get(session.id)).current
        expect(after?.agent).toBe("plan")
        expect(after?.model).toEqual(before?.model)
        expect(after?.variant).toEqual(before?.variant)
        await Session.remove(session.id)
      },
    })
  })

  test("setAgent is a safe no-op when the session has no current yet", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // A fresh session never sent a real message, so current is undefined. A
        // switch before that first send has nothing to record; setAgent must not
        // throw or synthesize a partial current.
        const session = await Session.create({})
        expect((await Session.get(session.id)).current).toBeUndefined()

        await Session.setAgent(session.id, "plan")
        expect((await Session.get(session.id)).current).toBeUndefined()
        await Session.remove(session.id)
      },
    })
  })

  test("a forked session inherits current from the original", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const original = await Session.create({})
        await SessionPrompt.prompt({
          variant: Provider.DEFAULT,
          sessionID: original.id,
          agent: "plan",
          model: MODEL,
          noReply: true,
          parts: [{ type: "text", text: "establish" }],
        })
        expect((await Session.get(original.id)).current?.agent).toBe("plan")

        const forked = await Session.fork({ sessionID: original.id })
        expect(forked.current?.agent).toBe("plan")
        expect(forked.current?.model).toEqual(MODEL)

        await Session.remove(forked.id)
        await Session.remove(original.id)
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
          model: Provider.DEFAULT,
          variant: Provider.DEFAULT,
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
