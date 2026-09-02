import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionSpawn } from "../../src/session/spawn"
import { SessionStatus } from "../../src/session/status"
import { SessionCompaction } from "../../src/session/compaction"
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

  // The debt outlives a failed delivery, because a report lost to a crash is
  // work nobody can recover: the parent never learns the helper finished, and
  // the next pass would find nothing to send.
  test("a report that could not be delivered stays owed", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        SessionSpawn.init()
        const parent = await Session.create({ title: "waiting peer" })
        const child = await Session.create({ title: "helper", spawnedBy: parent.id })

        // Nothing to summarise yet, so the delivery cannot complete. The debt
        // must survive for the pass that runs once there is an answer.
        SessionStatus.set(child.id, { type: "idle" })
        await Bun.sleep(200)
        expect((await Session.get(child.id)).spawn?.parent).toBe(parent.id)

        // With an answer written, the same helper now discharges.
        await answer(child.id, "the finding")
        SessionStatus.set(child.id, { type: "idle" })
        await Bun.sleep(200)

        expect((await Session.get(child.id)).spawn).toBeUndefined()
        expect(userTurns(await Session.messages({ sessionID: parent.id })).length).toBe(1)
      },
    })
  }, 20_000)

  // A helper whose parent is gone will never deliver, so its debt is retired
  // rather than retried on every pass for the life of the machine.
  test("a helper whose parent is gone stops owing a report", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        SessionSpawn.init()
        const parent = await Session.create({ title: "doomed peer" })
        const child = await Session.create({ title: "helper", spawnedBy: parent.id })
        await answer(child.id, "a finding nobody will read")
        await Session.remove(parent.id)

        SessionStatus.set(child.id, { type: "idle" })
        await Bun.sleep(200)

        expect((await Session.get(child.id)).spawn).toBeUndefined()
      },
    })
  }, 20_000)

  // The crash window: the report landed, then the process died before the debt
  // was retired. The next pass finds a debt that looks undischarged, and must
  // recognise the delivery already happened rather than writing a second copy.
  test("a report delivered but not yet retired is never sent twice", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        SessionSpawn.init()
        const parent = await Session.create({ title: "waiting peer" })
        const child = await Session.create({ title: "helper", spawnedBy: parent.id })

        await answer(child.id, "the finding")
        SessionStatus.set(child.id, { type: "idle" })
        await Bun.sleep(200)
        expect(userTurns(await Session.messages({ sessionID: parent.id })).length).toBe(1)

        // Exactly the state a crash between the stamp and the clear leaves: the
        // report is in the transcript and the debt still looks outstanding.
        await Session.update(child.id, (draft) => {
          draft.spawn = { parent: parent.id, directory: tmp.path, at: Date.now(), delivered: "msg_already" }
        })
        SessionStatus.set(child.id, { type: "idle" })
        await Bun.sleep(200)

        expect(userTurns(await Session.messages({ sessionID: parent.id })).length).toBe(1)
        expect((await Session.get(child.id)).spawn).toBeUndefined()
      },
    })
  }, 20_000)

  // Compaction rewrites a session's history in place, keeping its id. A helper
  // spawned before it still owes the SAME session its report, and a job started
  // before it still belongs to that session: nothing about compacting means the
  // work in flight was abandoned.
  test("a debt survives the parent being compacted", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        SessionSpawn.init()
        const parent = await Session.create({ title: "waiting peer" })
        const child = await Session.create({ title: "helper", spawnedBy: parent.id })

        // What compaction does to the parent: prune rewrites part text, and a
        // summary message is appended. The session id and record are untouched.
        await answer(parent.id, "a long answer that would be pruned")
        await SessionCompaction.prune({ sessionID: parent.id })

        expect((await Session.get(child.id)).spawn?.parent).toBe(parent.id)

        await answer(child.id, "the finding")
        SessionStatus.set(child.id, { type: "idle" })
        await Bun.sleep(200)

        // Delivered into the same session, after its history was rewritten.
        const delivered = userTurns(await Session.messages({ sessionID: parent.id }))
        expect(delivered.length).toBe(1)
        const text = delivered[0].parts.find((part) => part.type === "text")
        expect(text?.type === "text" && text.text).toContain("the finding")
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
