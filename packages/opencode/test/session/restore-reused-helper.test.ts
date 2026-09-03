import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPing } from "../../src/session/ping"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { tmpdir } from "../fixture/fixture"

// A reported helper (spawn.done) is left idle, not stopped, so it can be reused
// for a new turn. restore keys "leave it alone" off spawn.done, but a helper
// CUT OFF mid a fresh turn must still resume — otherwise a reused helper strands
// on exactly the interruption restore exists to heal. The discriminator is the
// last assistant turn's completion stamp.

async function assistant(sessionID: string, completed: boolean) {
  await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    parentID: Identifier.ascending("message"),
    role: "assistant",
    system: [],
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "test",
    providerID: "test",
    mode: "build",
    agent: "build",
    // The turn is interrupted iff its completion stamp is absent.
    time: completed ? { created: Date.now(), completed: Date.now() } : { created: Date.now() },
  } as MessageV2.Assistant)
}

async function resumedBy(marker: (id: string) => void) {
  await SessionPing.restore(async (session) => marker(session.id))
}

describe("SessionPing.restore reused-helper gate", () => {
  test("a reported helper cut off mid a fresh turn is resumed", async () => {
    await using tmp = await tmpdir({ git: true, config: { ping: { enabled: true } } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "waiting peer" })
        const helper = await Session.create({ title: "helper", spawnedBy: parent.id })
        // Reported once (done stamped), then kept warm and reused for a new turn
        // that a restart cut off (its last assistant turn has no completion).
        await Session.update(helper.id, (draft) => {
          if (draft.spawn) draft.spawn.done = Date.now()
          draft.keepWarm = true
          draft.cache = { lastRequestAt: Date.now() }
        })
        await assistant(helper.id, false)

        const resumed: string[] = []
        await resumedBy((id) => resumed.push(id))

        expect(resumed).toContain(helper.id)
      },
    })
  }, 20_000)

  test("a reported helper whose last turn completed is left alone", async () => {
    await using tmp = await tmpdir({ git: true, config: { ping: { enabled: true } } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "waiting peer" })
        const helper = await Session.create({ title: "helper", spawnedBy: parent.id })
        await Session.update(helper.id, (draft) => {
          if (draft.spawn) draft.spawn.done = Date.now()
          draft.keepWarm = true
          draft.cache = { lastRequestAt: Date.now() }
        })
        // Its reporting turn finished cleanly.
        await assistant(helper.id, true)

        const resumed: string[] = []
        await resumedBy((id) => resumed.push(id))

        expect(resumed).not.toContain(helper.id)
      },
    })
  }, 20_000)
})
