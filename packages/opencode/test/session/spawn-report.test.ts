import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionSpawn } from "../../src/session/spawn"
import { SessionStatus } from "../../src/session/status"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { tmpdir } from "../fixture/fixture"

// A helper session's result reaching the peer that asked for it cannot depend
// on the helper choosing to send it: one that ends its turn without reporting
// strands the waiter, and nothing notices. So the runtime watches the child go
// idle and delivers, the way an OTP supervisor observes a monitored child
// terminate rather than trusting it to announce itself.
async function answer(sessionID: string, text: string) {
  const messageID = Identifier.ascending("message")
  await Session.updateMessage({
    id: messageID,
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
    time: { created: Date.now(), completed: Date.now() },
  } as MessageV2.Assistant)
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID,
    sessionID,
    type: "text",
    text,
  })
}

function userTurns(messages: MessageV2.WithParts[]) {
  return messages.filter((msg) => msg.info.role === "user")
}

describe("SessionSpawn", () => {
  test("a helper that never reports still reports when it goes idle", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        SessionSpawn.init()
        const parent = await Session.create({ title: "waiting peer" })
        const child = await Session.create({ title: "helper", spawnedBy: parent.id })

        // The debt rides the record, so it survives anything that restarts the
        // process between the spawn and the child finishing.
        expect((await Session.get(child.id)).spawn?.parent).toBe(parent.id)

        await answer(child.id, "Two findings, both fixed.")
        // The child does nothing further: no report call, no delivery of its
        // own. Going idle is the whole of its participation.
        SessionStatus.set(child.id, { type: "idle" })
        await Bun.sleep(200)

        const delivered = userTurns(await Session.messages({ sessionID: parent.id }))
        expect(delivered.length).toBe(1)
        const text = delivered[0].parts.find((part) => part.type === "text")
        expect(text?.type === "text" && text.text).toContain("Two findings, both fixed.")
        // Named, so a reader of the parent knows which helper answered.
        expect(text?.type === "text" && text.text).toContain("helper")
      },
    })
  }, 20_000)

  test("the debt is discharged once, however often the child idles", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        SessionSpawn.init()
        const parent = await Session.create({ title: "waiting peer" })
        const child = await Session.create({ title: "helper", spawnedBy: parent.id })

        await answer(child.id, "first answer")
        SessionStatus.set(child.id, { type: "idle" })
        await Bun.sleep(200)
        // A follow-up prompt to the same helper idles it again; the waiter must
        // not receive the result a second time.
        await answer(child.id, "second answer")
        SessionStatus.set(child.id, { type: "idle" })
        await Bun.sleep(200)

        expect(userTurns(await Session.messages({ sessionID: parent.id })).length).toBe(1)
        expect((await Session.get(child.id)).spawn).toBeUndefined()
      },
    })
  }, 20_000)

  // A helper kept warm after its result landed pings a cache for a peer that is
  // no longer waiting, so the parent closes it down. The transcript stays
  // readable; only the daemon stops.
  test("a helper stops being kept warm once its result is delivered", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        SessionSpawn.init()
        const parent = await Session.create({ title: "waiting peer" })
        const child = await Session.create({ title: "helper", spawnedBy: parent.id })
        await Session.update(child.id, (draft) => {
          draft.keepWarm = true
        })

        await answer(child.id, "done")
        SessionStatus.set(child.id, { type: "idle" })
        await Bun.sleep(200)

        expect((await Session.get(child.id)).keepWarm).toBeFalsy()
        // Still readable: stopping is not deleting.
        expect((await Session.messages({ sessionID: child.id })).length).toBeGreaterThan(0)
      },
    })
  }, 20_000)

  test("a session nobody spawned delivers nothing", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        SessionSpawn.init()
        const solo = await Session.create({ title: "ordinary session" })
        await answer(solo.id, "an ordinary answer")
        SessionStatus.set(solo.id, { type: "idle" })
        await Bun.sleep(200)

        expect(userTurns(await Session.messages({ sessionID: solo.id })).length).toBe(0)
      },
    })
  }, 20_000)
})
