import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionSpawn } from "../../src/session/spawn"
import { SessionStatus } from "../../src/session/status"
import { SessionRecent } from "../../src/session/recent"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { tmpdir } from "../fixture/fixture"

// A spawned helper reports EXPLICITLY: it posts its result into the parent
// through the API and stamps its own `spawn.done`. The runtime does not
// infer completion from the child going idle, so nothing here delivers a report
// or reads the child's messages. `SessionSpawn.reconcile` only keeps the
// parent's "waiting on a helper" flag honest, derived from the debts on disk.

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
  await Session.updatePart({ id: Identifier.ascending("part"), messageID, sessionID, type: "text", text })
}

function userTurns(messages: MessageV2.WithParts[]) {
  return messages.filter((msg) => msg.info.role === "user")
}

async function busyHelper(parentID: string) {
  return (await SessionRecent.list()).find((row) => row.sessionID === parentID)?.busyHelper
}

describe("SessionSpawn: the helper flag follows the debts on disk", () => {
  // The whole point of the redesign: a child going idle delivers NOTHING. Only
  // an explicit report (which the child makes itself) reaches the parent.
  test("a child that goes idle without reporting delivers nothing", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        SessionSpawn.init()
        const parent = await Session.create({ title: "waiting peer" })
        const child = await Session.create({ title: "helper", spawnedBy: parent.id })

        // The child writes an interim message and idles. Under the old design
        // this was auto-delivered; now it must not be.
        await answer(child.id, "still working, not done yet")
        SessionStatus.set(child.id, { type: "idle" })
        await Bun.sleep(200)

        expect(userTurns(await Session.messages({ sessionID: parent.id })).length).toBe(0)
        // The debt is still outstanding: the child never reported.
        expect((await Session.get(child.id)).spawn?.done).toBeUndefined()
      },
    })
  }, 20_000)

  // The parent's spinner is on while a helper owes a report, and clears once the
  // helper stamps its own debt done.
  test("reconcile flags a parent that is owed and clears it once the debt is paid", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        SessionSpawn.init()
        const parent = await Session.create({ title: "waiting peer" })
        const child = await Session.create({ title: "helper", spawnedBy: parent.id })
        await SessionRecent.touch({ sessionID: parent.id, directory: tmp.path, title: "waiting peer", updated: Date.now() })

        // Creating the helper flags the parent; a sweep keeps it flagged while
        // the debt stands.
        await SessionSpawn.reconcile()
        expect(await busyHelper(parent.id)).toBe(true)

        // The child reports: it stamps its own debt done (what a report does
        // after it lands).
        await Session.update(child.id, (draft) => {
          if (draft.spawn) draft.spawn.done = Date.now()
        })
        await SessionSpawn.reconcile()

        expect(await busyHelper(parent.id)).toBe(false)
      },
    })
  }, 20_000)

  // A flag with no debt behind it is what a permanently spinning parent looks
  // like, so the sweep derives the set rather than trusting each edge.
  test("reconcile clears a helper flag no outstanding debt justifies", async () => {
    await using tmp = await tmpdir({ git: true })
    const parentID = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "flagged peer" })
        await answer(parent.id, "a turn, so it reaches the recent list")
        await SessionRecent.setBusyHelper(parent.id, true)
        return parent.id
      },
    })

    await SessionSpawn.reconcile()

    expect(await busyHelper(parentID)).toBeFalsy()
  }, 20_000)

  // A debt is retired ONLY by `done`. A helper that idled, was archived, or is
  // between turns still owes until it reports.
  test("only a stamped done retires a debt", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        SessionSpawn.init()
        const parent = await Session.create({ title: "waiting peer" })
        const child = await Session.create({ title: "helper", spawnedBy: parent.id })
        await SessionRecent.touch({ sessionID: parent.id, directory: tmp.path, title: "waiting peer", updated: Date.now() })

        // Archived, but not reported: still owed.
        await Session.update(child.id, (draft) => {
          draft.time.archived = Date.now()
        })
        await SessionSpawn.reconcile()
        expect(await busyHelper(parent.id)).toBe(true)

        // Reported: retired.
        await Session.update(child.id, (draft) => {
          if (draft.spawn) draft.spawn.done = Date.now()
        })
        await SessionSpawn.reconcile()
        expect(await busyHelper(parent.id)).toBe(false)
      },
    })
  }, 20_000)

  // The debt records the spawner's directory, so a helper in another project
  // still flags the parent that lives elsewhere.
  test("a helper in another project flags its parent at home", async () => {
    await using home = await tmpdir({ git: true })
    await using away = await tmpdir({ git: true })

    const parent = await Instance.provide({
      directory: home.path,
      fn: async () => {
        const p = await Session.create({ title: "waiting peer" })
        await SessionRecent.touch({ sessionID: p.id, directory: home.path, title: "waiting peer", updated: Date.now() })
        return p.id
      },
    })

    await Instance.provide({
      directory: away.path,
      fn: async () => {
        await Session.create({ title: "helper", spawnedBy: parent, spawnedFrom: home.path })
      },
    })

    await SessionSpawn.reconcile()

    await Instance.provide({
      directory: home.path,
      fn: async () => {
        expect(await busyHelper(parent)).toBe(true)
      },
    })
  }, 20_000)

  // The model/variant walk follows `spawn.parent` up the chain. The debt
  // is written once and never re-pointed, so the graph should be a forest, but
  // nothing enforces it and a cycle would hang the walk (every hop awaits, so it
  // is an unbounded async loop re-reading storage). The seen-set in `lastStamped`
  // bounds it; this proves a malformed cycle terminates rather than hanging.
  test("a spawn cycle terminates the inheritance walk instead of hanging", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const a = await Session.create({ title: "a" })
        const b = await Session.create({ title: "b" })
        await Session.update(a.id, (draft) => {
          draft.spawn = { parent: b.id, directory: tmp.path, at: Date.now() }
        })
        await Session.update(b.id, (draft) => {
          draft.spawn = { parent: a.id, directory: tmp.path, at: Date.now() }
        })

        const bounded = <T>(work: Promise<T>) => Promise.race([work, Bun.sleep(4000).then(() => "TIMEOUT" as const)])

        expect(await bounded(MessageV2.lastVariant(a.id))).toBeUndefined()
        expect(await bounded(MessageV2.lastModel(b.id))).toBeUndefined()
      },
    })
  }, 20_000)
})
