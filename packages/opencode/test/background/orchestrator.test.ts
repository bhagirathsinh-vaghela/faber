import { describe, expect, test, afterAll, afterEach } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { BackgroundJob } from "../../src/background/job"
import { BackgroundProcess } from "../../src/background/process"
import { BackgroundOrchestrator } from "../../src/background/orchestrator"
import { BackgroundReconcile } from "../../src/background/reconcile"
import { Recovery } from "../../src/session/recovery"
import { Debt } from "../../src/storage/debt"
import { connected, tmpdir } from "../fixture/fixture"

connected()

const created: string[] = []

function spawnJob(script: string) {
  return Bun.spawn({ cmd: ["sh", "-c", script], detached: true, stdio: ["ignore", "ignore", "ignore"] })
}

// A session that exists. It is idle, never armed, and absent from the recent
// list: the shape of nearly every session on a real machine.
async function owned() {
  const tmp = await tmpdir({ git: true })
  const id = await Instance.provide({
    directory: tmp.path,
    fn: async () => (await Session.createNext({ directory: tmp.path, title: "orchestrator test" })).id,
  })
  return { id, directory: tmp.path }
}

async function store(pid: number, owner: { id: string; directory: string }) {
  const live = (await BackgroundProcess.inspect(pid))!
  const id = BackgroundJob.id()
  created.push(id)
  const job: BackgroundJob.Info = {
    id,
    sessionID: owner.id,
    directory: owner.directory,
    command: "sleep 30",
    description: "orchestrator test",
    status: "running",
    time: { created: Date.now(), hard: Date.now() + 600_000 },
    process: { pid: live.pid, start: live.start, pgid: live.pgid },
  }
  await BackgroundJob.write(job)
  return job
}

afterEach(async () => {
  for (const id of created.splice(0)) {
    const job = await BackgroundJob.get(id)
    if (job?.process) await BackgroundProcess.kill(job.process)
    await BackgroundJob.remove(id)
    await Debt.remove(id)
  }
})

afterAll(() => Recovery.stop())

// A session read is scoped to the project its directory maps to, so a job whose
// recorded directory belongs to a different one finds no session. A pass never
// reads the session, so such a job is kept like any other.
describe("BackgroundOrchestrator: a job whose directory names another project", () => {
  test("a job carrying such a directory survives a pass", async () => {
    const proc = spawnJob("sleep 30")
    const live = (await BackgroundProcess.inspect(proc.pid))!
    const id = BackgroundJob.id()
    created.push(id)
    await BackgroundJob.write({
      id,
      sessionID: "ses_orchestrator_wrong_project",
      directory: "/tmp",
      command: "sleep 30",
      description: "wrong-project job",
      status: "running",
      time: { created: Date.now(), hard: Date.now() + 600_000 },
      process: { pid: live.pid, start: live.start, pgid: live.pgid },
    })

    const pass = await BackgroundReconcile.run()
    expect(pass.actions.find((entry) => entry.job.id === id)?.type).toBe("kept")
    expect((await BackgroundJob.get(id))?.status).toBe("running")
  }, 20_000)
})

// Surviving a pass is only half the job: a record whose session is never
// resolvable runs to completion and its result has nowhere to land. The
// command's cwd and the owner's project are therefore separate fields, and
// every session read uses the owner.
describe("BackgroundJob.owner", () => {
  test("resolves under the project rather than where the command ran", async () => {
    const elsewhere = await tmpdir({ git: true })
    const owner = await owned()
    expect(
      BackgroundJob.owner({
        id: BackgroundJob.id(),
        sessionID: owner.id,
        directory: elsewhere.path,
        project: owner.directory,
        command: "sleep 30",
        description: "workdir job",
        status: "running",
        time: { created: Date.now(), hard: Date.now() + 600_000 },
      }),
    ).toBe(owner.directory)
  })

  // With no `project` field the record's `directory` doubles as the owner path,
  // so the session stays resolvable.
  test("falls back to the recorded directory when no project was stored", () => {
    expect(
      BackgroundJob.owner({
        id: BackgroundJob.id(),
        sessionID: "ses_legacy",
        directory: "/legacy/project",
        command: "sleep 30",
        description: "legacy job",
        status: "running",
        time: { created: Date.now(), hard: Date.now() + 600_000 },
      }),
    ).toBe("/legacy/project")
  })

  // The whole point of the split: a session stays findable when the command
  // ran somewhere that maps to a different project entirely.
  test("a job whose cwd is outside the project still resolves its session", async () => {
    const elsewhere = await tmpdir({ git: true })
    const owner = await owned()
    const job: BackgroundJob.Info = {
      id: BackgroundJob.id(),
      sessionID: owner.id,
      directory: elsewhere.path,
      project: owner.directory,
      command: "sleep 30",
      description: "workdir job",
      status: "running",
      time: { created: Date.now(), hard: Date.now() + 600_000 },
    }

    const found = await Instance.provide({
      directory: BackgroundJob.owner(job),
      fn: () => Session.get(job.sessionID),
    })
    expect(found.id).toBe(owner.id)
  })

  // An idle session is the ordinary case, not an abandoned one: its user reads
  // the result when the job finishes, which is the whole reason a job outlives
  // the turn that started it.
  test("a live job owned by an idle session survives a pass", async () => {
    const owner = await owned()
    const proc = spawnJob("sleep 30")
    const job = await store(proc.pid, owner)

    const pass = await BackgroundReconcile.run()

    expect(pass.actions.find((action) => action.job.id === job.id)?.type).toBe("kept")
    expect(await BackgroundJob.get(job.id)).toBeDefined()
    expect(await BackgroundProcess.verify(job.process!)).toBe("alive")
    proc.kill()
  })
})

// A settled job's result is a debt Recovery pays. When the session it belongs to
// is gone there is nobody to pay, so the debt goes; a delivery that throws keeps
// its debt for a later process.
describe("BackgroundOrchestrator: a result with nowhere to go", () => {
  // A running record whose process has gone, owed to `sessionID`: what a sweep
  // finds after a job ended while nothing held its handle.
  async function ended(sessionID: string, project: string, record: Partial<BackgroundJob.Info> = {}) {
    const proc = spawnJob("true")
    await proc.exited
    const id = BackgroundJob.id()
    created.push(id)
    await BackgroundJob.write({
      id,
      sessionID,
      directory: project,
      project,
      command: "true",
      description: "undeliverable job",
      status: "running",
      time: { created: Date.now(), hard: Date.now() + 600_000 },
      process: { pid: proc.pid, start: "gone", pgid: proc.pid },
      ...record,
    })
    await Debt.add(id, "job", sessionID)
    return id
  }

  // Driven through sweep(), so the test fails if a sweep that settles a job
  // stops waking recovery to pay it.
  test("drops the debt of a session that does not exist", async () => {
    const project = await tmpdir({ git: true })
    const id = await ended("ses_orchestrator_undeliverable", project.path)

    Recovery.start()
    await BackgroundOrchestrator.sweep()

    expect((await BackgroundJob.get(id))?.status).toBe("exited")
    expect(await Debt.has(id)).toBe(false)
  }, 20_000)

  // A delivery that throws keeps its debt past every retry; the jobs behind it
  // in the same pass are reached.
  test("a job whose delivery throws keeps its debt and does not stop the jobs behind it", async () => {
    const owner = await owned()
    const first = await ended("ses_orchestrator_before_throw", owner.directory)
    // No command: rendering the result throws inside the delivery.
    const middle = await ended(owner.id, owner.directory, { command: undefined })
    const last = await ended("ses_orchestrator_after_throw", owner.directory)

    Recovery.start()
    await BackgroundOrchestrator.sweep()
    await Recovery.poke()
    await Recovery.poke()
    await Recovery.poke()

    expect(await Debt.has(first)).toBe(false)
    expect(await Debt.has(last)).toBe(false)
    expect(await Debt.has(middle)).toBe(true)
  }, 20_000)
})

// A reaped record takes its debt with it: a debt naming no record holds its
// session open (a subagent's report waits on it) until recovery notices.
describe("BackgroundReconcile: a reaped job's debt", () => {
  test("goes with a record that names no process", async () => {
    const id = BackgroundJob.id()
    created.push(id)
    await BackgroundJob.write({
      id,
      sessionID: "ses_orchestrator_orphan",
      directory: "/tmp",
      command: "sleep 30",
      description: "orphaned job",
      status: "running",
      time: { created: Date.now(), hard: Date.now() + 600_000 },
    })
    await Debt.add(id, "job", "ses_orchestrator_orphan")

    const pass = await BackgroundReconcile.run()
    const action = pass.actions.find((entry) => entry.job.id === id)

    expect(action?.type).toBe("reaped")
    expect(action?.type === "reaped" && action.reason).toBe("orphaned")
    expect(await BackgroundJob.get(id)).toBeUndefined()
    expect(await Debt.has(id)).toBe(false)
  })
})

// The nudge is delivered on its own timer, reading the running set off disk and
// claiming each due job. A job past its soft deadline gets exactly one nudge per
// call, stamped on the record so the next call paces off it.
describe("BackgroundOrchestrator.nudgeAll", () => {
  test("a process whose recovery gate is closed sends no check-in and stamps nothing", async () => {
    Recovery.stop()
    const owner = await owned()
    const proc = spawnJob("sleep 30")
    const live = (await BackgroundProcess.inspect(proc.pid))!
    const id = BackgroundJob.id()
    created.push(id)
    const now = Date.now()
    await BackgroundJob.write({
      id,
      sessionID: owner.id,
      directory: owner.directory,
      project: owner.directory,
      command: "sleep 30",
      description: "staged nudge",
      status: "running",
      time: { created: now - 300_000, soft: now - 200_000, hard: now + 600_000 },
      process: { pid: live.pid, start: live.start, pgid: live.pgid },
    })

    await BackgroundOrchestrator.nudgeAll(now)

    expect((await BackgroundJob.get(id))?.time.nudges).toBeUndefined()
    const messages = await Instance.provide({
      directory: owner.directory,
      fn: () => Session.messages({ sessionID: owner.id }),
    })
    expect(messages).toEqual([])
    proc.kill()
  }, 20_000)

  test("nudges a running job past its soft deadline and stamps it", async () => {
    Recovery.start()
    const owner = await owned()
    const proc = spawnJob("sleep 30")
    const live = (await BackgroundProcess.inspect(proc.pid))!
    const id = BackgroundJob.id()
    created.push(id)
    const now = Date.now()
    await BackgroundJob.write({
      id,
      sessionID: owner.id,
      directory: owner.directory,
      project: owner.directory,
      command: "sleep 30",
      description: "nudge test",
      status: "running",
      time: { created: now - 300_000, soft: now - 200_000, hard: now + 600_000 },
      process: { pid: live.pid, start: live.start, pgid: live.pgid },
    })

    await BackgroundOrchestrator.nudgeAll(now)

    expect((await BackgroundJob.get(id))?.time.nudges).toBe(1)
    proc.kill()
  }, 20_000)

  test("does not nudge a job still inside its soft deadline", async () => {
    Recovery.start()
    const owner = await owned()
    const proc = spawnJob("sleep 30")
    const live = (await BackgroundProcess.inspect(proc.pid))!
    const id = BackgroundJob.id()
    created.push(id)
    const now = Date.now()
    await BackgroundJob.write({
      id,
      sessionID: owner.id,
      directory: owner.directory,
      project: owner.directory,
      command: "sleep 30",
      description: "nudge test",
      status: "running",
      time: { created: now, soft: now + 600_000, hard: now + 900_000 },
      process: { pid: live.pid, start: live.start, pgid: live.pgid },
    })

    await BackgroundOrchestrator.nudgeAll(now)

    expect((await BackgroundJob.get(id))?.time.nudges).toBeUndefined()
    proc.kill()
  }, 20_000)

  // The prose the reader actually receives is what has to change between the
  // first nudge and the repeats, so the delivered message is asserted, not just
  // the disk stamp: the ordinal render keys on is written by the claim, so a
  // deliver from the pre-claim copy renders every second nudge as the first.
  test("the second nudge is delivered with the tighter repeat prose", async () => {
    Recovery.start()
    const owner = await owned()
    const proc = spawnJob("sleep 30")
    const live = (await BackgroundProcess.inspect(proc.pid))!
    const id = BackgroundJob.id()
    created.push(id)
    const now = Date.now()
    await BackgroundJob.write({
      id,
      sessionID: owner.id,
      directory: owner.directory,
      project: owner.directory,
      command: "sleep 30",
      description: "nudge test",
      status: "running",
      time: { created: now - 300_000, soft: now - 1, hard: now + 3_600_000 },
      process: { pid: live.pid, start: live.start, pgid: live.pgid },
    })

    await BackgroundOrchestrator.nudgeAll(now)
    await BackgroundOrchestrator.nudgeAll(now + BackgroundJob.NUDGE_MS)

    const texts = await Instance.provide({
      directory: owner.directory,
      fn: async () => {
        const messages = await Session.messages({ sessionID: owner.id })
        return messages.flatMap((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))
      },
    })
    const checkins = texts.filter((text) => text.includes("still running after"))
    expect(checkins.length).toBe(2)
    expect(checkins[0]).toContain("No action needed")
    expect(checkins[1]).toContain("FYI only.")
    expect(checkins[1]).not.toContain("No action needed")
    proc.kill()
  }, 20_000)
})

describe("BackgroundOrchestrator.sweep", () => {
  // A sweep can be fired by the abort route or the exit watcher at any moment,
  // including right after boot, and none of them may reap a live job.
  test("keeps a live job owned by an idle session", async () => {
    const proc = spawnJob("sleep 30")
    const job = await store(proc.pid, await owned())

    await BackgroundOrchestrator.sweep()

    expect((await BackgroundJob.get(job.id))?.status).toBe("running")
    expect(await BackgroundProcess.verify(job.process!)).toBe("alive")
  }, 20_000)

  test("reaps a record whose spawn never landed, and its debt", async () => {
    const id = BackgroundJob.id()
    created.push(id)
    await BackgroundJob.write({
      id,
      sessionID: "ses_orchestrator_sweep_orphan",
      directory: "/tmp",
      command: "sleep 30",
      description: "orphaned job",
      status: "running",
      time: { created: Date.now(), hard: Date.now() + 600_000 },
    })
    await Debt.add(id, "job", "ses_orchestrator_sweep_orphan")

    await BackgroundOrchestrator.sweep()

    expect(await BackgroundJob.get(id)).toBeUndefined()
    expect(await Debt.has(id)).toBe(false)
  }, 20_000)
})

// Removing a record takes its output with it, so a finished job still owed to
// its session outlives the age bound; one owed nothing does not.
describe("BackgroundJob.cleanup", () => {
  async function aged(sessionID: string) {
    const id = BackgroundJob.id()
    created.push(id)
    const old = Date.now() - BackgroundJob.MAX_AGE_MS - 60_000
    await BackgroundJob.write({
      id,
      sessionID,
      directory: "/tmp",
      command: "true",
      description: "aged job",
      status: "exited",
      exit: 0,
      time: { created: old, hard: old + 600_000, completed: old },
    })
    return id
  }

  test("keeps a job past the age bound while a debt names it", async () => {
    const id = await aged("ses_orchestrator_cleanup_owed")
    await Debt.add(id, "job", "ses_orchestrator_cleanup_owed")

    await BackgroundJob.cleanup()

    expect((await BackgroundJob.get(id))?.status).toBe("exited")
    expect(await Debt.has(id)).toBe(true)
  })

  test("removes a job past the age bound once nothing is owed", async () => {
    const id = await aged("ses_orchestrator_cleanup_paid")

    await BackgroundJob.cleanup()

    expect(await BackgroundJob.get(id)).toBeUndefined()
  })
})
