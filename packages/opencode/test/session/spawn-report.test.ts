import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionSpawn } from "../../src/session/spawn"
import { SessionStatus } from "../../src/session/status"
import { SessionCompaction } from "../../src/session/compaction"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { SessionRecent } from "../../src/session/recent"
import { SessionPrompt } from "../../src/session/prompt"
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
        expect((await Session.get(child.id)).spawn?.done).toBeNumber()
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

  // The stop is the LAST act of the discharge. It runs on the idle event, which
  // fires while the turn is still unwinding, so anything after it races the
  // turn's own tail: an arm landing behind the stop leaves the helper pinging
  // for a peer that already has its answer. Ordering is what rules that out,
  // and the record is where the ordering is visible.
  test("the report is stamped before the helper is stopped", async () => {
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

        const settled = await Session.get(child.id)
        expect(settled.spawn?.delivered).toBeString()
        expect(settled.spawn?.done).toBeNumber()
        expect(settled.keepWarm).toBeFalsy()
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

        expect((await Session.get(child.id)).spawn?.done).toBeNumber()
        expect(userTurns(await Session.messages({ sessionID: parent.id })).length).toBe(1)
      },
    })
  }, 20_000)

  // Archiving is how a helper is cut off before it finishes, and an archived
  // session runs no further turn — so the answer this pass is waiting for can
  // never arrive. Holding the debt open leaves the parent flagged as waiting on
  // work that cannot come, and that flag outranks every other colour on its
  // spinner, so the parent reads as waiting on a helper forever.
  test("a debt no archived helper can pay is retired", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        SessionSpawn.init()
        const parent = await Session.create({ title: "waiting peer" })
        const child = await Session.create({ title: "helper", spawnedBy: parent.id })
        await SessionRecent.touch({
          sessionID: parent.id,
          directory: tmp.path,
          title: "waiting peer",
          updated: Date.now(),
        })
        await SessionRecent.setBusyHelper(parent.id, true)

        // Cut off with nothing written, which is what a stop leaves behind.
        await Session.update(child.id, (draft) => {
          draft.time.archived = Date.now()
        })

        SessionStatus.set(child.id, { type: "idle" })
        await Bun.sleep(200)

        expect((await Session.get(child.id)).spawn?.done).toBeNumber()
        expect(userTurns(await Session.messages({ sessionID: parent.id })).length).toBe(0)
        const entry = (await SessionRecent.list()).find((row) => row.sessionID === parent.id)
        expect(entry?.busyHelper).toBe(false)
      },
    })
  }, 20_000)

  // A deleted parent and a parent that merely could not be resolved look
  // IDENTICAL from here — both are a lookup returning nothing. Since one of
  // those is recoverable and the other is not, the debt is kept either way: a
  // retained debt for a parent that truly went away costs one skipped record per
  // pass, while retiring on a failed lookup destroys a report whose reader is
  // still waiting for it.
  test("a helper whose parent is gone keeps its debt rather than destroying the report", async () => {
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

        const spawn = (await Session.get(child.id)).spawn
        expect(spawn?.done).toBeUndefined()
        expect(spawn?.claimed).toBeUndefined()
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
        expect((await Session.get(child.id)).spawn?.done).toBeNumber()
      },
    })
  }, 20_000)

  // The record OUTLIVES the debt it carried. It is the only durable evidence
  // that this session is a finished helper rather than one whose turn happened
  // to be interrupted, and a caller that restarts sessions decides between
  // those two by reading it.
  test("a discharged helper keeps a stamped record rather than losing it", async () => {
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

        const spawn = (await Session.get(child.id)).spawn
        expect(spawn?.parent).toBe(parent.id)
        expect(spawn?.done).toBeNumber()
        // Released with the debt: a claim left behind would be read as a
        // delivery in progress by whatever next inspects the record.
        expect(spawn?.claimed).toBeUndefined()
      },
    })
  }, 20_000)

  // `done` retires the debt on its OWN, without leaning on the delivered stamp
  // beside it. A helper retired because its parent could not be found carries no
  // stamp, so a path that only recognises `delivered` would run the whole
  // delivery again the next time that helper went idle.
  test("a helper retired without a delivered stamp is never delivered later", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        SessionSpawn.init()
        const parent = await Session.create({ title: "waiting peer" })
        const child = await Session.create({ title: "helper", spawnedBy: parent.id })
        await answer(child.id, "the finding")

        // Exactly what the parent-gone path leaves behind: retired, with no
        // report ever written and so nothing stamped.
        await Session.update(child.id, (draft) => {
          if (draft.spawn) draft.spawn.done = Date.now()
        })

        SessionStatus.set(child.id, { type: "idle" })
        await Bun.sleep(200)

        expect(userTurns(await Session.messages({ sessionID: parent.id })).length).toBe(0)
      },
    })
  }, 20_000)

  // A retained record must not read as an outstanding debt, or the pass that
  // heals a stranded report would re-deliver every discharged helper forever.
  test("a discharged helper is not owed by the reconcile pass", async () => {
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

        await SessionSpawn.reconcile()
        await SessionSpawn.reconcile()

        expect(userTurns(await Session.messages({ sessionID: parent.id })).length).toBe(1)
        const entry = (await SessionRecent.list()).find((row) => row.sessionID === parent.id)
        expect(entry?.busyHelper).toBe(false)
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

  // A helper does its work wherever the job is, which is not always where the
  // peer waiting on it lives. The debt resolves the parent under a recorded
  // directory, and a session resolves only under its own project, so recording
  // the helper's own directory loses every cross-project report.
  test("a helper in another project still reports home", async () => {
    await using home = await tmpdir({ git: true })
    await using away = await tmpdir({ git: true })

    const parent = await Instance.provide({
      directory: home.path,
      fn: async () => (await Session.create({ title: "waiting peer" })).id,
    })

    const child = await Instance.provide({
      directory: away.path,
      fn: async () => {
        SessionSpawn.init()
        const helper = await Session.create({ title: "helper", spawnedBy: parent, spawnedFrom: home.path })
        await answer(helper.id, "the cross-project finding")
        SessionStatus.set(helper.id, { type: "idle" })
        await Bun.sleep(200)
        return helper.id
      },
    })

    await Instance.provide({
      directory: home.path,
      fn: async () => {
        const delivered = userTurns(await Session.messages({ sessionID: parent }))
        expect(delivered.length).toBe(1)
        const text = delivered[0].parts.find((part) => part.type === "text")
        expect(text?.type === "text" && text.text).toContain("the cross-project finding")
      },
    })

    await Instance.provide({
      directory: away.path,
      fn: async () => {
        expect((await Session.get(child)).spawn?.done).toBeNumber()
      },
    })
  }, 20_000)

  // An unresolved parent is NOT an absent one. Retiring the debt on a lookup
  // that merely failed destroys a report whose reader is alive and waiting, so
  // the debt stays outstanding for a pass that can resolve it.
  test("a debt whose parent cannot be resolved is kept, not destroyed", async () => {
    await using home = await tmpdir({ git: true })
    await using away = await tmpdir({ git: true })

    const parent = await Instance.provide({
      directory: home.path,
      fn: async () => (await Session.create({ title: "waiting peer" })).id,
    })

    await Instance.provide({
      directory: away.path,
      fn: async () => {
        SessionSpawn.init()
        // The defective shape: the debt points at the parent but records the
        // helper's own directory, so the parent cannot be resolved from here.
        const helper = await Session.create({ title: "helper", spawnedBy: parent })
        await answer(helper.id, "the finding")
        SessionStatus.set(helper.id, { type: "idle" })
        await Bun.sleep(200)

        const spawn = (await Session.get(helper.id)).spawn
        expect(spawn?.parent).toBe(parent)
        expect(spawn?.done).toBeUndefined()
        // Released, so the pass that can resolve the parent is free to try.
        expect(spawn?.claimed).toBeUndefined()
      },
    })
  }, 20_000)

  // The backstop, driven directly rather than through the idle event. Every
  // other test here reaches discharge from an idle, so stubbing the pass out
  // leaves them all green while the failures it exists to heal go unhealed.
  describe("the reconcile pass", () => {
    test("delivers for a helper that never emits an idle event", async () => {
      await using tmp = await tmpdir({ git: true })
      const ids = await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const parent = await Session.create({ title: "waiting peer" })
          const child = await Session.create({ title: "helper", spawnedBy: parent.id })
          await answer(child.id, "found it")
          return { parent: parent.id, child: child.id }
        },
      })

      // No idle is set: this is the helper that was killed, crashed, or was
      // never prompted, so nothing will ever announce it.
      await SessionSpawn.reconcile()

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect((await Session.get(ids.child)).spawn?.done).toBeNumber()
          expect(userTurns(await Session.messages({ sessionID: ids.parent })).length).toBe(1)
        },
      })
    }, 20_000)

    // A flag with no debt behind it is what a permanently spinning session
    // looks like, so the pass derives the set rather than trusting each edge.
    test("clears a helper flag that no outstanding debt justifies", async () => {
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

      const entry = (await SessionRecent.list()).find((row) => row.sessionID === parentID)
      expect(entry?.busyHelper).toBeFalsy()
    }, 20_000)
  })

  // `settling` is a module-level set, so it guards one process. Two servers
  // share the store during a staged cutover, and the claim on the record is
  // what stops each of them delivering its own copy of one report.
  test("a debt already claimed by another pass is left alone", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        SessionSpawn.init()
        const parent = await Session.create({ title: "waiting peer" })
        const child = await Session.create({ title: "helper", spawnedBy: parent.id })
        await answer(child.id, "the finding")

        // What another server mid-delivery looks like from here.
        await Session.update(child.id, (draft) => {
          if (draft.spawn) draft.spawn.claimed = Date.now()
        })

        await SessionSpawn.reconcile()

        // Its delivery is the other server's to make, so this pass wrote
        // nothing and left the debt for it.
        expect(userTurns(await Session.messages({ sessionID: parent.id })).length).toBe(0)
        expect((await Session.get(child.id)).spawn?.claimed).toBeGreaterThan(0)
      },
    })
  }, 20_000)

  // A claim outliving the process that took it would strand the debt for good,
  // which is worse than the duplicate the claim prevents.
  test("a stale claim is taken over rather than trusted", async () => {
    await using tmp = await tmpdir({ git: true })
    const ids = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "waiting peer" })
        const child = await Session.create({ title: "helper", spawnedBy: parent.id })
        await answer(child.id, "the finding")
        await Session.update(child.id, (draft) => {
          if (draft.spawn) draft.spawn.claimed = Date.now() - 60 * 60 * 1000
        })
        return { parent: parent.id, child: child.id }
      },
    })

    await SessionSpawn.reconcile()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(userTurns(await Session.messages({ sessionID: ids.parent })).length).toBe(1)
        expect((await Session.get(ids.child)).spawn?.done).toBeNumber()
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

  // The derive at the end of a pass must read the debts AFTER that pass acted
  // on them. A set built during the loop describes the state before the
  // discharge, so a debt retired by this pass would be re-asserted by its own
  // derive: the flag cleared and set again inside one pass, leaving the parent
  // spinning on a report it already holds until the next sweep.
  test("one reconcile pass leaves the parent unflagged", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "waiting peer" })
        const child = await Session.create({ title: "helper", spawnedBy: parent.id })
        await SessionRecent.touch({
          sessionID: parent.id,
          directory: tmp.path,
          title: "waiting peer",
          updated: Date.now(),
        })
        await SessionRecent.setBusyHelper(parent.id, true)
        await answer(child.id, "the finding")

        await SessionSpawn.reconcile()

        expect(userTurns(await Session.messages({ sessionID: parent.id })).length).toBe(1)
        const entry = (await SessionRecent.list()).find((row) => row.sessionID === parent.id)
        expect(entry?.busyHelper).toBe(false)
      },
    })
  }, 20_000)

  // The debt is written once at creation and never re-pointed, so the graph
  // should be a forest. Nothing enforces that, and a cycle hangs rather than
  // crashing: every hop awaits, so it is an unbounded async loop re-reading
  // storage. The walk carries a seen-set the way SessionBusy.chain does.
  test("a spawn cycle terminates instead of hanging", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const solo = await Session.create({ title: "self-referential" })
        await Session.update(solo.id, (draft) => {
          draft.spawn = { parent: solo.id, directory: tmp.path, at: Date.now() }
        })

        const a = await Session.create({ title: "a" })
        const b = await Session.create({ title: "b" })
        await Session.update(a.id, (draft) => {
          draft.spawn = { parent: b.id, directory: tmp.path, at: Date.now() }
        })
        await Session.update(b.id, (draft) => {
          draft.spawn = { parent: a.id, directory: tmp.path, at: Date.now() }
        })

        const bounded = <T>(work: Promise<T>) =>
          Promise.race([work, Bun.sleep(4000).then(() => "TIMEOUT" as const)])

        expect(await bounded(MessageV2.lastVariant(solo.id))).toBeUndefined()
        expect(await bounded(MessageV2.lastVariant(a.id))).toBeUndefined()
        expect(await bounded(MessageV2.lastModel(b.id))).toBeUndefined()
      },
    })
  }, 20_000)

  // A report that lands without waking the parent is text in a transcript that
  // nobody reads. The parent asked for the work, the answer arrived, and
  // nothing acts on it until something unrelated happens to start a turn: the
  // same stranding this mechanism exists to prevent, moved from a peer that
  // never reported to a spawner that never read what it was sent. A delivered
  // JOB result already wakes its session; a delivered report must too.
  test("a delivered report wakes the session it was delivered to", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        SessionSpawn.init()
        const parent = await Session.create({ title: "waiting peer" })
        const child = await Session.create({ title: "helper", spawnedBy: parent.id })

        const woke: string[] = []
        const real = SessionPrompt.loop
        // @ts-expect-error - swapped for the assertion, restored below
        SessionPrompt.loop = async (id: string) => {
          woke.push(id)
          return undefined
        }

        try {
          await answer(child.id, "the finding")
          SessionStatus.set(child.id, { type: "idle" })
          await Bun.sleep(300)
        } finally {
          // @ts-expect-error - restoring the real implementation
          SessionPrompt.loop = real
        }

        expect(userTurns(await Session.messages({ sessionID: parent.id })).length).toBe(1)
        expect(woke).toContain(parent.id)
      },
    })
  }, 20_000)
})
