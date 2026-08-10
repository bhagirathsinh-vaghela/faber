import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPing } from "../../src/session/ping"
import { tmpdir } from "../fixture/fixture"

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

describe("SessionPing directory teardown", () => {
  test("Instance.dispose stops the directory's armed ping daemons", async () => {
    await using tmp = await tmpdir({ git: true, config: { ping: { enabled: true } } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        SessionPing.start(session.id)
        await settle()
        expect(SessionPing.list()).toEqual([session.id])

        await Instance.dispose()
        expect(SessionPing.list()).toEqual([])
      },
    })
  })
})
