import { describe, expect, test } from "bun:test"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("promptAsync ack ordering", () => {
  // The async route acks on this callback, so the message must be durable by the
  // time it fires. A client that reads the pre-allocated id right after the ack
  // then gets a truthful answer instead of a race against the write.
  test("onPersisted fires only after the message is readable", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const messageID = Identifier.ascending("message")

        let roleAtPersist: string | undefined
        await SessionPrompt.promptAsync(
          {
            sessionID: session.id,
            messageID,
            noReply: true,
            parts: [{ type: "text", text: "probe" }],
          },
          async () => {
            const stored = await MessageV2.get({ sessionID: session.id, messageID })
            roleAtPersist = stored.info.role
          },
        )

        expect(roleAtPersist).toBe("user")
      },
    })
  }, 30000)
})
