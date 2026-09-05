import { describe, expect, test } from "bun:test"
import { Session } from "../../src/session"
import { SessionBusy } from "../../src/session/busy"
import { SessionRevert } from "../../src/session/revert"
import { SessionPing } from "../../src/session/ping"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

function assistant(sessionID: string, parentID: string): MessageV2.Assistant {
  return {
    id: Identifier.ascending("message"),
    sessionID,
    parentID,
    role: "assistant",
    time: { created: Date.now() },
    modelID: "claude-fable-5",
    providerID: "anthropic",
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

describe("Session.updateMessage terminal fields", () => {
  test("a writer holding a pre-completion copy cannot unset finish", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const msg = assistant(session.id, Identifier.ascending("message"))

        const stale = { ...msg }
        await Session.updateMessage(msg)

        msg.finish = "stop"
        msg.time.completed = Date.now()
        await Session.updateMessage(msg)

        stale.promptIndex = 430
        await Session.updateMessage(stale)

        const stored = await storedAssistant(session.id, msg.id)
        expect(stored.finish).toBe("stop")
        expect(stored.time.completed).toBeNumber()
        expect(stored.promptIndex).toBe(430)
      },
    })
  })

  test("the turn that owns the message may still set its terminal fields", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const msg = assistant(session.id, Identifier.ascending("message"))
        await Session.updateMessage(msg)

        msg.finish = "tool-calls"
        msg.time.completed = Date.now()
        await Session.updateMessage(msg)

        const first = await storedAssistant(session.id, msg.id)
        expect(first.finish).toBe("tool-calls")

        msg.finish = "stop"
        await Session.updateMessage(msg)

        const second = await storedAssistant(session.id, msg.id)
        expect(second.finish).toBe("stop")
      },
    })
  })

  test("an error is preserved against a stale copy the same way finish is", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const msg = assistant(session.id, Identifier.ascending("message"))
        const stale = { ...msg }
        await Session.updateMessage(msg)

        msg.error = { name: "APIError", data: { message: "boom", isRetryable: false } }
        msg.time.completed = Date.now()
        await Session.updateMessage(msg)

        await Session.updateMessage(stale)

        const stored = await storedAssistant(session.id, msg.id)
        expect(stored.error?.name).toBe("APIError")
      },
    })
  })

  test("a user message is written through untouched", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const user: MessageV2.User = {
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude-fable-5" },
        }
        await Session.updateMessage(user)
        user.ordinal = 7
        await Session.updateMessage(user)

        const stored = await readMessage(user.id)
        expect(stored.role).toBe("user")
        expect((stored as MessageV2.User).ordinal).toBe(7)
      },
    })
  })
})

describe("revert survives the terminal-field guard", () => {
  test("a reverted message is removed, and a re-answered turn keeps its own finish", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const user: MessageV2.User = {
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude-fable-5" },
        }
        await Session.updateMessage(user)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: user.id,
          sessionID: session.id,
          type: "text",
          text: "do the thing",
        })

        const answer = assistant(session.id, user.id)
        answer.finish = "stop"
        answer.time.completed = Date.now()
        await Session.updateMessage(answer)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: answer.id,
          sessionID: session.id,
          type: "text",
          text: "done",
        })

        await SessionRevert.revert({ sessionID: session.id, messageID: answer.id })
        await SessionRevert.cleanup(await Session.get(session.id))

        const remaining = await Session.messages({ sessionID: session.id })
        expect(remaining.some((m) => m.info.id === answer.id)).toBe(false)

        const replacement = assistant(session.id, user.id)
        replacement.finish = "stop"
        replacement.time.completed = Date.now()
        await Session.updateMessage(replacement)

        const stored = await storedAssistant(session.id, replacement.id)
        expect(stored.finish).toBe("stop")
      },
    })
  })

  test("unrevert restores the session and leaves terminal fields intact", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const msg = assistant(session.id, Identifier.ascending("message"))
        msg.finish = "stop"
        msg.time.completed = Date.now()
        await Session.updateMessage(msg)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: msg.id,
          sessionID: session.id,
          type: "text",
          text: "answer",
        })

        await SessionRevert.revert({ sessionID: session.id, messageID: msg.id })
        expect((await Session.get(session.id)).revert).toBeDefined()

        await SessionRevert.unrevert({ sessionID: session.id })
        expect((await Session.get(session.id)).revert).toBeUndefined()

        const stored = await storedAssistant(session.id, msg.id)
        expect(stored.finish).toBe("stop")
      },
    })
  })
})

describe("SessionPing during a turn", () => {
  // A ping must dispatch while a turn is in flight: a turn parked in a long
  // tool call dispatches nothing, so the anchor sits still and the window
  // lapses under it. Failure here is silent, costing only a cold cache, which
  // is why it is pinned.
  test("a ping on a busy session reaches provider resolution", async () => {
    await using workspace = await tmpdir({ git: true, config: { ping: { enabled: false } } })
    await Instance.provide({
      directory: workspace.path,
      fn: async () => {
        const session = await Session.create({})
        const user: MessageV2.User = {
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: "definitely-not-a-provider", modelID: "nope" },
        }
        await Session.updateMessage(user)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: user.id,
          sessionID: session.id,
          type: "text",
          text: "hello",
        })

        SessionBusy.enter(session.id)
        const failure = await SessionPing.probe(session.id, "").then(
          () => undefined,
          (err: Error) => err,
        )
        SessionBusy.exit(session.id)

        expect(failure?.name ?? "").toBe("ProviderModelNotFoundError")
      },
    })
  }, 30000) // provider resolution loads the models registry on first use
})

describe("SessionBusy.busy", () => {
  test("resolves without an ambient Instance", async () => {
    await using tmp = await tmpdir({ git: true })
    const sessionID = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        SessionBusy.enter(session.id)
        return session.id
      },
    })

    expect(SessionBusy.busy(sessionID)).toBe(true)

    await Instance.provide({ directory: tmp.path, fn: async () => SessionBusy.exit(sessionID) })
    expect(SessionBusy.busy(sessionID)).toBe(false)
  })
})

async function readMessage(messageID: string) {
  const { Messages } = await import("../../src/storage/messages")
  return Messages.read(messageID)
}

async function storedAssistant(sessionID: string, messageID: string) {
  const stored = await readMessage(messageID)
  if (stored.role !== "assistant") throw new Error(`expected an assistant message, got ${stored.role}`)
  return stored
}
