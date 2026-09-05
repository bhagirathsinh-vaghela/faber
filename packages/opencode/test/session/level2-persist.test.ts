import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { Parts } from "../../src/storage/parts"
import { Bus } from "../../src/bus"
import { Identifier } from "../../src/id/id"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

function textPart(sessionID: string, messageID: string, body: string): MessageV2.TextPart {
  return { id: Identifier.ascending("part"), messageID, sessionID, type: "text", text: body }
}

describe("Level 2 persistence discipline", () => {
  // A streaming block publishes every delta live but persists only at block-end.
  // publishPart is the live-only half: it must reach the bus without writing a row.
  test("publishPart broadcasts the part but writes no row", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const messageID = Identifier.ascending("message")
        const part = textPart(session.id, messageID, "streaming")

        const seen: string[] = []
        const unsub = Bus.subscribe(MessageV2.Event.PartUpdated, (evt) => {
          if (evt.properties.part.id === part.id) seen.push(evt.properties.delta ?? "")
        })

        Session.publishPart(part, "streaming")
        // Let the synchronous publish flush to subscribers.
        await Promise.resolve()
        unsub()

        expect(seen).toEqual(["streaming"])
        expect(await Parts.list(messageID)).toEqual({ parts: [], size: 0 })
      },
    })
  })

  // updatePart is the persisting half: the single block-end write.
  test("updatePart persists the part exactly once", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const messageID = Identifier.ascending("message")
        const part = textPart(session.id, messageID, "final")

        await Session.updatePart(part)

        expect(await Parts.list(messageID)).toEqual({
          parts: [part],
          size: Buffer.byteLength(JSON.stringify(part)),
        })
      },
    })
  })
})
