import { describe, expect, test } from "bun:test"
import path from "path"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPing } from "../../src/session/ping"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

// The continue prompt is the load-bearing half of the resume contract: it is
// what makes a resumed parent WAIT for its subagent's injection rather than
// re-launch the work. The clause must appear exactly when subagents came back,
// and say "do not re-launch".
describe("SessionPing.continueText", () => {
  test("no subagent clause when none were resumed", () => {
    const text = SessionPing.continueText(0)
    expect(text).toContain("your turn was cut off")
    expect(text).not.toContain("re-launch")
    expect(text).not.toContain("subagent")
  })

  test("singular clause tells the parent to wait for its one subagent", () => {
    const text = SessionPing.continueText(1)
    expect(text).toContain("The subagent you launched was resumed")
    expect(text).toContain("do NOT re-launch it")
    expect(text).toContain("wait for it")
  })

  test("plural clause names the count and forbids re-launch", () => {
    const text = SessionPing.continueText(3)
    expect(text).toContain("The 3 subagents you launched were resumed")
    expect(text).toContain("do NOT re-launch them")
  })
})

// The real filter resumeSubagents keys on. `SessionPing.interrupted` is called
// directly (not reimplemented) so a change to its discriminator is caught here:
// a cut turn has no completion stamp (resume), a finished or user-stopped one
// does (skip, since the abort tail stamps it the same as a clean finish).
describe("SessionPing.interrupted", () => {
  async function child(parentID: string, completed: boolean) {
    const session = await Session.create({ parentID, title: "resume test child" })
    await Session.updateMessage({
      id: Identifier.ascending("message"),
      sessionID: session.id,
      parentID: Identifier.ascending("message"),
      role: "assistant",
      time: completed ? { created: Date.now(), completed: Date.now() } : { created: Date.now() },
      system: [],
      path: { cwd: projectRoot, root: projectRoot },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test",
      providerID: "test",
      mode: "build",
      agent: "build",
    } as MessageV2.Assistant)
    return session
  }

  test("true for a cut turn, false for a finished one", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const parent = await Session.create({ title: "resume test parent" })
        const cut = await child(parent.id, false)
        const done = await child(parent.id, true)

        expect(await SessionPing.interrupted(cut.id)).toBe(true)
        expect(await SessionPing.interrupted(done.id)).toBe(false)

        await Session.remove(cut.id)
        await Session.remove(done.id)
        await Session.remove(parent.id)
      },
    })
  })

  // A subagent dialog reads this: it merges the durable child sessions with the
  // in-memory tasks, deduped by child session, so it survives a restart and
  // never double-counts a resumed child. With no in-memory tasks (the
  // post-restart state), it is entirely disk-derived: a finished child reads
  // completed, a cut child running, and each appears exactly once.
  test("subagentsForSession derives status from the child sessions on disk", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const parent = await Session.create({ title: "resume test parent" })
        const cut = await child(parent.id, false)
        const done = await child(parent.id, true)

        const { subagentsForSession } = await import("../../src/tool/task")
        const tasks = await subagentsForSession(parent.id)
        const byChild = new Map(tasks.map((t) => [t.subagent?.sessionID, t]))

        expect(tasks.length).toBe(2)
        expect(byChild.get(cut.id)?.status).toBe("running")
        expect(byChild.get(done.id)?.status).toBe("completed")

        await Session.remove(cut.id)
        await Session.remove(done.id)
        await Session.remove(parent.id)
      },
    })
  })
})
