import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPing } from "../../src/session/ping"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("SessionPing arming", () => {
  test("a stop issued while start() reads config leaves no daemon armed", async () => {
    await using tmp = await tmpdir({ git: true, config: { ping: { enabled: true } } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        SessionPing.start(session.id)
        await SessionPing.stop(session.id)
        await Bun.sleep(100)
        expect(SessionPing.list()).toEqual([])
        expect((await Session.get(session.id)).keepWarm).toBe(false)
      },
    })
  })

  test("arming and stopping a daemon leave the session's last-activity time alone", async () => {
    await using tmp = await tmpdir({ git: true, config: { ping: { enabled: true } } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const before = (await Session.get(session.id)).time.updated
        await Bun.sleep(5)
        SessionPing.start(session.id)
        await Bun.sleep(100)
        expect((await Session.get(session.id)).keepWarm).toBe(true)
        await SessionPing.stop(session.id)
        expect((await Session.get(session.id)).time.updated).toBe(before)
      },
    })
  })
})
