import { describe, expect, test } from "bun:test"
import { Session } from "../../src/session"
import { SessionPing } from "../../src/session/ping"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

describe("session.delete ping teardown", () => {
  test("deleting a session disarms its ping daemon and does not resurrect it", async () => {
    await using tmp = await tmpdir({ git: true, config: { ping: { enabled: true } } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        SessionPing.start(session.id)
        await settle()
        expect(SessionPing.list()).toEqual([session.id])

        // The route resolves its own instance from ?directory=, ignoring the
        // ambient one, so the request must name the tmpdir or it deletes against
        // a different project's storage.
        const app = Server.App()
        const response = await app.request(
          `/session/${session.id}?directory=${encodeURIComponent(tmp.path)}`,
          { method: "DELETE" },
        )
        expect(response.status).toBe(200)
        await settle()

        expect(SessionPing.list()).toEqual([])
        // disarm writes keepWarm through Session.update, which persists and
        // re-indexes — so a disarm ordered after the delete would write the
        // session back. Absence here is what proves the ordering.
        expect(await Session.get(session.id).catch(() => undefined)).toBeUndefined()
      },
    })
  })

  test("deleting a parent leaves no armed daemon behind", async () => {
    await using tmp = await tmpdir({ git: true, config: { ping: { enabled: true } } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})
        const child = await Session.create({ parentID: parent.id })
        SessionPing.start(parent.id)
        SessionPing.start(child.id)
        await settle()
        // A child self-stops: the daemon's own evaluate() returns "stop" for any
        // session with a parentID, so only the parent stays armed.
        expect(SessionPing.list()).toEqual([parent.id])

        const app = Server.App()
        const response = await app.request(`/session/${parent.id}?directory=${encodeURIComponent(tmp.path)}`, {
          method: "DELETE",
        })
        expect(response.status).toBe(200)
        await settle()

        expect(SessionPing.list()).toEqual([])
        expect(await Session.get(child.id).catch(() => undefined)).toBeUndefined()
      },
    })
  })
})
