import { describe, expect, test } from "bun:test"
import { Session } from "../../src/session"
import { SessionPing } from "../../src/session/ping"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

async function armed(sessionID: string) {
  for (let tries = 0; tries < 100 && !SessionPing.list().includes(sessionID); tries++) await Bun.sleep(10)
}

describe("attended-only pings", () => {
  test("POST /arm arms a warm root and leaves a warm ephemeral session unarmed", async () => {
    await using tmp = await tmpdir({ git: true, config: { ping: { enabled: true } } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const warm = (draft: Session.Info) => void (draft.cache = { lastRequestAt: Date.now() })
        const ephemeral = await Session.createNext({ directory: tmp.path, ephemeral: true })
        const root = await Session.create({})
        await Session.update(ephemeral.id, warm, { touch: false })
        await Session.update(root.id, warm, { touch: false })
        const arm = (id: string) =>
          Server.App().request(`/session/${id}/arm?directory=${encodeURIComponent(tmp.path)}`, { method: "POST" })

        expect((await arm(ephemeral.id)).status).toBe(200)
        expect((await arm(root.id)).status).toBe(200)
        await armed(root.id)

        expect(SessionPing.list()).toEqual([root.id])
        await SessionPing.stop(root.id)
      },
    })
  }, 20_000)
})

describe("GET /session/:id/debts", () => {
  test("an unknown session id answers 404", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const missing = Identifier.descending("session")
        const response = await Server.App().request(
          `/session/${missing}/debts?directory=${encodeURIComponent(tmp.path)}`,
        )
        expect(response.status).toBe(404)
        expect(((await response.json()) as { name: string }).name).toBe("NotFoundError")
      },
    })
  })
})
