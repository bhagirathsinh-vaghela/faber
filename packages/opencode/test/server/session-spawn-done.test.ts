import { describe, expect, test } from "bun:test"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

// A reporting helper retires its own debt by PATCHing spawnDone on itself. This
// is the ONLY thing that stamps spawn.done, so the flag sweep clears the
// parent's spinner off it. The route stamps the time and touches nothing else.
describe("session.update spawnDone", () => {
  test("stamps spawn.done on a helper that has a spawn record", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "waiting peer" })
        const child = await Session.create({ title: "helper", spawnedBy: parent.id })
        expect((await Session.get(child.id)).spawn?.done).toBeUndefined()

        const app = Server.App()
        const res = await app.request(`/session/${child.id}?directory=${encodeURIComponent(tmp.path)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ spawnDone: true }),
        })
        expect(res.status).toBe(200)

        expect((await Session.get(child.id)).spawn?.done).toBeNumber()
      },
    })
  })

  test("does nothing to a session that has no spawn record", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const solo = await Session.create({ title: "ordinary session" })

        const app = Server.App()
        const res = await app.request(`/session/${solo.id}?directory=${encodeURIComponent(tmp.path)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ spawnDone: true }),
        })
        expect(res.status).toBe(200)

        expect((await Session.get(solo.id)).spawn).toBeUndefined()
      },
    })
  })
})
