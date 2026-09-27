import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Bus } from "../../src/bus"
import { GlobalBus } from "../../src/bus/global"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { SessionBusy } from "../../src/session/busy"
import { SessionPrompt } from "../../src/session/prompt"
import { BackgroundJob } from "../../src/background/job"
import type { BackgroundSubagent } from "../../src/background"
import { SubagentWatch } from "../../src/tool/subagent-watch"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

const DEBOUNCE = 50

// A watcher whose inject callback records every output it delivers, so a test
// can assert both whether the watcher fired and with what.
function harness(child: Session.Info) {
  const outputs: string[] = []
  const task: BackgroundSubagent.Info = {
    id: Identifier.ascending("part"),
    parentSessionID: child.parentID!,
    status: "running",
    description: "watch test",
    time: { created: Date.now() },
    subagent: { sessionID: child.id, agent: "build", prompt: "", model: MessageV2.UNKNOWN_MODEL },
  }
  return { outputs, task }
}

// Membership is driven through the exact events the watcher listens to, so the
// test exercises the real subscriptions rather than a stubbed set.
function enterTurn(childID: string) {
  Bus.publish(SessionBusy.Event.Working, { sessionID: childID, busy: true, busySelf: true, busyDescendant: false })
}
function exitTurn(childID: string) {
  Bus.publish(SessionBusy.Event.Working, { sessionID: childID, busy: false, busySelf: false, busyDescendant: false })
}
function interrupt(childID: string) {
  Bus.publish(SessionPrompt.Event.Interrupted, { sessionID: childID, interrupted: true })
}
function job(childID: string, id: string, status: BackgroundJob.Status) {
  const info: BackgroundJob.Info = {
    id,
    sessionID: childID,
    directory: "/tmp",
    command: "sleep 1",
    description: "job",
    status,
    time: { created: Date.now(), hard: Date.now() + 60_000 },
  }
  GlobalBus.emit("event", { payload: { type: BackgroundJob.Event.Updated.type, properties: { job: info } } })
}

async function until(pred: () => boolean, budget = DEBOUNCE * 6) {
  const deadline = Date.now() + budget
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 5))
  }
  return pred()
}

async function withChild(fn: (child: Session.Info) => Promise<void>) {
  await Instance.provide({
    directory: projectRoot,
    fn: async () => {
      const parent = await Session.create({})
      const child = await Session.create({ parentID: parent.id })
      const messageID = Identifier.ascending("message")
      await Session.updateMessage({
        id: messageID,
        sessionID: child.id,
        role: "assistant",
        parentID: Identifier.ascending("message"),
        mode: "build",
        agent: "build",
        path: { cwd: projectRoot, root: projectRoot },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "claude-x",
        providerID: "anthropic",
        time: { created: Date.now(), completed: Date.now() },
      } as MessageV2.Assistant)
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID,
        sessionID: child.id,
        type: "text",
        text: "child done",
      })
      try {
        await fn(child)
      } finally {
        SubagentWatch.stop(child.id)
        await Session.remove(parent.id)
      }
    },
  })
}

describe("SubagentWatch", () => {
  // A turn that enters and exits with no jobs is quiescent once the debounce
  // elapses: the watcher fires exactly once, with the child's last assistant
  // text.
  test("fires after the turn ends and the debounce elapses", async () => {
    await withChild(async (child) => {
      const { outputs, task } = harness(child)
      SubagentWatch.start({ child, parentID: task.parentSessionID, debounceMs: DEBOUNCE, inject: async (o) => void outputs.push(o) })

      enterTurn(child.id)
      exitTurn(child.id)

      expect(await until(() => outputs.length === 1)).toBe(true)
      expect(outputs).toEqual(["child done"])
      expect(SubagentWatch.count()).toBe(0)
    })
  })

  // A job still in the set holds the injection past the debounce; only once the
  // job leaves running does the timer get to run out.
  test("waits for a running job before firing", async () => {
    await withChild(async (child) => {
      const { outputs, task } = harness(child)
      SubagentWatch.start({ child, parentID: task.parentSessionID, debounceMs: DEBOUNCE, inject: async (o) => void outputs.push(o) })

      enterTurn(child.id)
      job(child.id, "job-a", "running")
      exitTurn(child.id)

      // The turn is gone but the job keeps the set non-empty: no fire.
      await new Promise((r) => setTimeout(r, DEBOUNCE * 2))
      expect(outputs.length).toBe(0)

      job(child.id, "job-a", "exited")
      expect(await until(() => outputs.length === 1)).toBe(true)
      expect(outputs).toEqual(["child done"])
    })
  })

  // A fresh turn arriving inside the debounce window cancels the pending timer,
  // so the watcher fires only after the LATER empty + debounce.
  test("a turn add within the debounce cancels the pending fire", async () => {
    await withChild(async (child) => {
      const { outputs, task } = harness(child)
      SubagentWatch.start({ child, parentID: task.parentSessionID, debounceMs: DEBOUNCE, inject: async (o) => void outputs.push(o) })

      enterTurn(child.id)
      exitTurn(child.id)
      // Re-open before the timer runs out; the pending fire must be cancelled.
      await new Promise((r) => setTimeout(r, DEBOUNCE / 2))
      enterTurn(child.id)
      await new Promise((r) => setTimeout(r, DEBOUNCE * 2))
      expect(outputs.length).toBe(0)

      exitTurn(child.id)
      expect(await until(() => outputs.length === 1)).toBe(true)
      expect(outputs).toEqual(["child done"])
    })
  })

  // An interruption keeps the watcher from ever firing on its own; a subsequent
  // turn add clears it and then the ordinary quiescence path fires.
  test("an interruption blocks firing until a turn clears it", async () => {
    await withChild(async (child) => {
      const { outputs, task } = harness(child)
      SubagentWatch.start({ child, parentID: task.parentSessionID, debounceMs: DEBOUNCE, inject: async (o) => void outputs.push(o) })

      interrupt(child.id)
      await new Promise((r) => setTimeout(r, DEBOUNCE * 3))
      expect(outputs.length).toBe(0)

      // The next turn clears the interruption; ending it then fires.
      enterTurn(child.id)
      exitTurn(child.id)
      expect(await until(() => outputs.length === 1)).toBe(true)
      expect(outputs).toEqual(["child done"])
    })
  })

  // Two jobs settling at different times: the set is empty only after BOTH
  // leave running, so the fire waits for the slower one.
  test("fires only after two staggered jobs both finish", async () => {
    await withChild(async (child) => {
      const { outputs, task } = harness(child)
      SubagentWatch.start({ child, parentID: task.parentSessionID, debounceMs: DEBOUNCE, inject: async (o) => void outputs.push(o) })

      enterTurn(child.id)
      job(child.id, "job-a", "running")
      job(child.id, "job-b", "running")
      exitTurn(child.id)

      job(child.id, "job-a", "exited")
      await new Promise((r) => setTimeout(r, DEBOUNCE * 2))
      expect(outputs.length).toBe(0)

      job(child.id, "job-b", "exited")
      expect(await until(() => outputs.length === 1)).toBe(true)
      expect(outputs).toEqual(["child done"])
    })
  })

  // A resume seeds the set from disk (a job already running, no turn). The
  // watcher must not fire until that seeded job's Updated event leaves running.
  test("a seeded running job holds the fire until its Updated event clears it", async () => {
    await withChild(async (child) => {
      const { outputs, task } = harness(child)
      SubagentWatch.start({
        child,
        parentID: task.parentSessionID,
        seed: new Set(["job:seed-1"]),
        debounceMs: DEBOUNCE,
        inject: async (o) => void outputs.push(o),
      })

      await new Promise((r) => setTimeout(r, DEBOUNCE * 2))
      expect(outputs.length).toBe(0)

      job(child.id, "seed-1", "exited")
      expect(await until(() => outputs.length === 1)).toBe(true)
      expect(outputs).toEqual(["child done"])
    })
  })

  // A second start for the same child is a no-op: the first watcher's timer is
  // the only one, so a single quiescence fires exactly once.
  test("a second start for the same child is a no-op", async () => {
    await withChild(async (child) => {
      const { outputs, task } = harness(child)
      SubagentWatch.start({ child, parentID: task.parentSessionID, debounceMs: DEBOUNCE, inject: async (o) => void outputs.push(o) })
      expect(SubagentWatch.count()).toBe(1)

      // A second start with a DIFFERENT inject must be ignored entirely.
      const second: string[] = []
      SubagentWatch.start({ child, parentID: task.parentSessionID, debounceMs: DEBOUNCE, inject: async (o) => void second.push(o) })
      expect(SubagentWatch.count()).toBe(1)

      enterTurn(child.id)
      exitTurn(child.id)
      expect(await until(() => outputs.length === 1)).toBe(true)
      expect(outputs).toEqual(["child done"])
      expect(second).toEqual([])
    })
  })
})
