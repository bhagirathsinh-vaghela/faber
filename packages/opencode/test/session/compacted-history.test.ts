import { describe, expect, test } from "bun:test"
import { Session } from "../../src/session"
import { SessionRecent } from "../../src/session/recent"
import { SessionRevert } from "../../src/session/revert"
import { MessageV2 } from "../../src/session/message-v2"
import { Instance } from "../../src/project/instance"
import { Identifier } from "../../src/id/id"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const model = { providerID: "openai", modelID: "gpt-4" }

async function user(sessionID: string, part: { type: "text"; text: string } | { type: "compaction"; auto: boolean }) {
  const info = await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID,
    agent: "build",
    model,
    time: { created: Date.now() },
  })
  await Session.updatePart({ id: Identifier.ascending("part"), messageID: info.id, sessionID, ...part })
  return info.id
}

async function assistant(sessionID: string, parentID: string, summary?: boolean) {
  const info: MessageV2.Assistant = {
    id: Identifier.ascending("message"),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: Instance.directory, root: Instance.directory },
    cost: 0,
    tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: model.modelID,
    providerID: model.providerID,
    parentID,
    summary,
    time: { created: Date.now(), completed: Date.now() },
    finish: "stop",
  }
  await Session.updateMessage(info)
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: info.id,
    sessionID,
    type: "text",
    text: summary ? "summary" : "reply",
  })
  return info.id
}

describe("pre-compaction history", () => {
  test("a revert to a message before the last compaction removes it and everything after", async () => {
    await using tmp = await tmpdir({ git: true, config: { undo: { revertFiles: false } } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const first = await user(session.id, { type: "text", text: "one" })
        const reply = await assistant(session.id, first)
        const second = await user(session.id, { type: "text", text: "two" })
        await assistant(session.id, second)
        const compaction = await user(session.id, { type: "compaction", auto: false })
        await assistant(session.id, compaction, true)
        await user(session.id, { type: "text", text: "three" })

        await SessionRevert.revert({ sessionID: session.id, messageID: second })
        await SessionRevert.cleanup(await Session.get(session.id))

        const left = await Session.messages({ sessionID: session.id, compacted: false })
        expect(left.map((m) => m.info.id)).toEqual([first, reply])
        // Emits the hub row's pending update now, while the data dir exists.
        await SessionRecent.remove(session.id)
      },
    })
  })
})
