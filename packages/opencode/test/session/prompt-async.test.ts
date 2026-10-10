import { describe, expect, test } from "bun:test"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { connected, tmpdir } from "../fixture/fixture"
import { Provider } from "../../src/provider/provider"

connected()

Log.init({ print: false })

describe("send ack ordering", () => {
  // The async route acks once this resolves, so the message must be durable by
  // then. A client that reads the pre-allocated id right after the ack gets a
  // truthful answer instead of a race against the write.
  test("resolves only after the message is readable", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const messageID = Identifier.ascending("message")

        const sent = await SessionPrompt.send({
          model: Provider.DEFAULT,
          variant: Provider.DEFAULT,
          sessionID: session.id,
          messageID,
          noReply: true,
          parts: [{ type: "text", text: "probe" }],
        })

        expect(sent.message.info.id).toBe(messageID)
        expect((await MessageV2.get({ sessionID: session.id, messageID })).info.role).toBe("user")
        await sent.answer
      },
    })
  }, 30000)
})
