import { describe, expect, test } from "bun:test"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

function userTurns(messages: Awaited<ReturnType<typeof Session.messages>>) {
  return messages.filter((msg) => msg.info.role === "user")
}

// The atomic report route does the two writes a reporting helper needs — deliver
// into the spawner, stamp the helper's own spawn.done — in ONE server call. That
// atomicity is the whole point: a restart cannot land between a delivered report
// and the stamp, so a resumed helper cannot deliver the report a second time.
describe("session.report", () => {
  test("delivers into the spawner and retires the helper's debt in one call", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "waiting peer" })
        const child = await Session.create({ title: "helper", spawnedBy: parent.id })
        expect(userTurns(await Session.messages({ sessionID: parent.id })).length).toBe(0)
        expect((await Session.get(child.id)).spawn?.done).toBeUndefined()

        const app = Server.App()
        const res = await app.request(`/session/${child.id}/report?directory=${encodeURIComponent(tmp.path)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            parentID: parent.id,
            parentDirectory: tmp.path,
            parts: [{ type: "text", text: "the findings, in full" }],
          }),
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ delivered: true })

        // Both writes landed: the report is a user turn in the parent, and the
        // child's own debt is stamped done.
        const turns = userTurns(await Session.messages({ sessionID: parent.id }))
        expect(turns.length).toBe(1)
        expect((await Session.get(child.id)).spawn?.done).toBeNumber()
      },
    })
  }, 20_000)

  // A helper whose spawner lives in a DIFFERENT project still reports home: the
  // route resolves the spawner under the directory the helper passes, not its
  // own. Without that, the delivery would find nothing and the debt would stay
  // open (a session resolves only under its own project).
  test("delivers across projects using the spawner's own directory", async () => {
    await using parentTmp = await tmpdir({ git: true })
    await using childTmp = await tmpdir({ git: true })

    const parent = await Instance.provide({
      directory: parentTmp.path,
      fn: () => Session.create({ title: "spawner in project A" }),
    })
    const child = await Instance.provide({
      directory: childTmp.path,
      fn: () => Session.create({ title: "helper in project B", spawnedBy: parent.id }),
    })

    const app = Server.App()
    const res = await app.request(`/session/${child.id}/report?directory=${encodeURIComponent(childTmp.path)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parentID: parent.id,
        parentDirectory: parentTmp.path,
        parts: [{ type: "text", text: "cross-project findings" }],
      }),
    })
    expect(res.status).toBe(200)

    const turns = await Instance.provide({
      directory: parentTmp.path,
      fn: async () => userTurns(await Session.messages({ sessionID: parent.id })),
    })
    expect(turns.length).toBe(1)
    const stamped = await Instance.provide({
      directory: childTmp.path,
      fn: async () => (await Session.get(child.id)).spawn?.done,
    })
    expect(stamped).toBeNumber()
  }, 20_000)
})
