import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

async function completed(sessionID: string, partBytes: number) {
  const message: MessageV2.Assistant = {
    id: Identifier.ascending("message"),
    sessionID,
    parentID: Identifier.ascending("message"),
    role: "assistant",
    time: { created: Date.now(), completed: Date.now() },
    modelID: "claude-fable-5",
    providerID: "anthropic",
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  await Session.updateMessage(message)
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: message.id,
    sessionID,
    type: "text",
    text: "x".repeat(partBytes),
  })
  return message.id
}

describe("MessageV2 record cache", () => {
  // A record the cache refuses is re-read from disk on every pass for the life
  // of the session, and the largest turns are the most expensive to redo. The
  // ceiling has to clear a real turn's payload or the cache costs more than it
  // saves on exactly the sessions that need it.
  test("a large completed turn is served from cache, not re-read", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const messageID = await completed(session.id, 300 * 1024)

        const first = await MessageV2.get({ sessionID: session.id, messageID })
        const second = await MessageV2.get({ sessionID: session.id, messageID })

        expect(second).toBe(first)
      },
    })
  })

  test("a small completed turn is served from cache", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const messageID = await completed(session.id, 512)

        const first = await MessageV2.get({ sessionID: session.id, messageID })
        const second = await MessageV2.get({ sessionID: session.id, messageID })

        expect(second).toBe(first)
      },
    })
  })

  test("uncache forces the next read to rebuild the record", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const messageID = await completed(session.id, 1024)

        const first = await MessageV2.get({ sessionID: session.id, messageID })
        MessageV2.uncache(messageID)
        const rebuilt = await MessageV2.get({ sessionID: session.id, messageID })

        expect(rebuilt).not.toBe(first)
        expect(rebuilt.info.id).toBe(first.info.id)
        expect(rebuilt.parts.length).toBe(first.parts.length)
      },
    })
  })

  test("a record's parts survive the cached round trip intact", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const messageID = await completed(session.id, 4096)

        const record = await MessageV2.get({ sessionID: session.id, messageID })

        expect(record.parts.length).toBe(1)
        expect(record.parts[0].type).toBe("text")
        expect((record.parts[0] as MessageV2.TextPart).text.length).toBe(4096)
      },
    })
  })
})
