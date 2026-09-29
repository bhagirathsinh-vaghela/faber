import { describe, expect, test } from "bun:test"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Debt } from "../../src/storage/debt"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

// `noReply` writes the message without starting a turn, so the route's ack is
// decided by the durable write alone and no provider is needed.
function post(directory: string, sessionID: string, text: string) {
  return Server.App().request(`/session/${sessionID}/prompt_async?directory=${encodeURIComponent(directory)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ noReply: true, parts: [{ type: "text", text }] }),
  })
}

describe("session.prompt_async", () => {
  test("acks 204 once the prompt is durable", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const response = await post(tmp.path, session.id, "stored")

        expect(response.status).toBe(204)
        const texts = (await Session.messages({ sessionID: session.id })).flatMap((message) =>
          message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
        )
        expect(texts).toEqual(["stored"])
      },
    })
  })

  test("a detached turn that fails after the 204 reports failed to the parent once and leaves the route serving", async () => {
    await using tmp = await tmpdir({ git: true, config: { ping: { enabled: false } } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})
        const child = await Session.create({ parentID: parent.id })
        const response = await Server.App().request(
          `/session/${child.id}/prompt_async?directory=${encodeURIComponent(tmp.path)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: { providerID: "definitely-not-a-provider", modelID: "nope" },
              parts: [{ type: "text", text: "fail" }],
            }),
          },
        )
        expect(response.status).toBe(204)

        const statuses = async () =>
          (await Session.messages({ sessionID: parent.id })).flatMap((message) =>
            message.parts.flatMap((part) =>
              part.type === "text" && part.backgroundSubagentResult ? [part.backgroundSubagentResult.status] : [],
            ),
          )
        for (let tries = 0; tries < 200 && (await Debt.get(child.id)); tries++) await Bun.sleep(50)
        expect(await Debt.get(child.id)).toBeUndefined()
        expect(await statuses()).toEqual(["failed"])

        expect((await post(tmp.path, parent.id, "still serving")).status).toBe(204)
      },
    })
  }, 30_000)

  test("a prompt that cannot be persisted answers an error, not 204", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const missing = Identifier.descending("session")
        const response = await post(tmp.path, missing, "lost")

        expect(response.status).toBe(404)
        expect(((await response.json()) as { name: string }).name).toBe("NotFoundError")
      },
    })
  })
})
