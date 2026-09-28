import { describe, expect, test, afterAll, afterEach } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { BackgroundJob } from "../../src/background/job"
import { BackgroundProcess } from "../../src/background/process"
import { BackgroundOrchestrator } from "../../src/background/orchestrator"
import { BackgroundReconcile } from "../../src/background/reconcile"
import { Recovery } from "../../src/session/recovery"
import { Owed } from "../../src/storage/owed"
import { tmpdir } from "../fixture/fixture"

const created: string[] = []

function spawnJob(script: string) {
  return Bun.spawn({ cmd: ["sh", "-c", script], detached: true, stdio: ["ignore", "ignore", "ignore"] })
}

// A session that exists. It is idle, never armed, and absent from the recent
// list — the shape of nearly every session on a real machine, and the one a
// reap must never touch. `aliveFor` answers `true` for it.
async function owned() {
  const tmp = await tmpdir({ git: true })
  const id = await Instance.provide({
    directory: tmp.path,
    fn: async () => (await Session.createNext({ directory: tmp.path, title: "orchestrator test" })).id,
  })
  return { id, directory: tmp.path }
}

// The `false` verdict, supplied directly. `aliveFor` never produces one: it
// answers `true` for a session it can read and `undefined` for one it cannot,
// so the reap belongs to a caller that knows something the predicate does not.
// Reaching it through a stub is what keeps the reap tested without pretending
// an idle session earns it.
const gone = async () => false as const

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
    await Owed.remove(id)
  }
})

afterAll(() => Recovery.stop())

// A boot sweep must not reap a job whose session cannot be resolved yet:
// liveness is rebuilt after the sweep runs, so every session reads as absent
// and ownership is not knowable at that moment.
//
// Driven through sweep() rather than the reconciler beneath it, because the
// flag under test lives here — a test against the reconciler passes whether or
// not this guard exists.
// A session read is scoped to the project its directory maps to, so a job whose
// recorded directory belongs to a different one finds nothing. That is a failed
// lookup, not a deleted session, and reaping on it kills healthy work — the
// reachable case being any job run with a `workdir` outside the project.
describe("BackgroundOrchestrator: a job whose directory names another project", () => {
  // Driven through the reconciler with the ORCHESTRATOR'S OWN predicate rather
  // than through sweep(): a fresh process is inside its settle window, so
  // sweep() defers every ownership verdict and would pass whatever the
  // predicate returns.
  test("reports unknown rather than gone when the session is not in that project", async () => {
    const alive = BackgroundOrchestrator.aliveFor
    expect(await alive("ses_orchestrator_wrong_project", "/tmp")).toBeUndefined()
  })

  test("resolves a session that IS in the given project", async () => {
    // Its own directory, where nothing is stored either, so the miss is the
    // project scoping rather than the id: both must read as unknown, never as
    // a deletion.
    const alive = BackgroundOrchestrator.aliveFor
    expect(await alive("ses_orchestrator_absent", process.cwd())).toBeUndefined()
  })

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

    const pass = await BackgroundReconcile.run({ alive: BackgroundOrchestrator.aliveFor })
    expect(pass.actions.find((entry) => entry.job.id === id)?.type).toBe("kept")
    expect(await BackgroundJob.get(id)).toBeDefined()
  }, 20_000)
})

// Surviving the ownership verdict is only half the job: a record that is kept
// but never resolvable runs to completion and is dropped at delivery, which is
// strictly worse than being reaped early. The command's cwd and the owner's
// project are therefore separate fields, and every session read uses the owner.
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

    // Resolvable (a real verdict) under the owner, unknowable under the cwd.
    expect(await BackgroundOrchestrator.aliveFor(job.sessionID, BackgroundJob.owner(job))).toBe(true)
    expect(await BackgroundOrchestrator.aliveFor(job.sessionID, job.directory)).toBeUndefined()
  })

  // An idle session is the ordinary case, not an abandoned one: its turn ended
  // and its user reads the result when the job finishes, which is the whole
  // reason a job outlives the turn that started it. A predicate keyed on
  // activity answers `false` for nearly every session on a real machine.
  test("a session that exists is kept, however idle", async () => {
    const owner = await owned()
    expect(await BackgroundOrchestrator.aliveFor(owner.id, owner.directory)).toBe(true)
  })

  // The end-to-end shape of the same rule: a live process owned by an idle
  // session survives a full pass. The predicate above is what decides it, and a
  // pass is what would have killed it.
  test("a live job owned by an idle session survives a pass", async () => {
    const owner = await owned()
    const proc = spawnJob("sleep 30")
    const job = await store(proc.pid, owner)

    const pass = await BackgroundReconcile.run({ alive: BackgroundOrchestrator.aliveFor })

    expect(pass.actions.find((action) => action.job.id === job.id)?.type).not.toBe("reaped")
    expect(await BackgroundJob.get(job.id)).toBeDefined()
    expect(await BackgroundProcess.verify(job.process!)).toBe("alive")
    proc.kill()
  })
})

// A settled job's result is a debt Recovery pays. When the session it belongs to
// is gone there is nowhere to pay it, so the record is stamped lost and the debt
// dropped: the result is recorded as unread rather than retried forever.
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
    await Owed.add(id, sessionID)
    return id
  }

  // Driven through sweep(), so the test fails if a sweep that settles a job
  // stops waking recovery to pay it.
  test("stamps the record lost and drops the debt", async () => {
    const project = await tmpdir({ git: true })
    const id = await ended("ses_orchestrator_undeliverable", project.path)

    Recovery.start()
    await BackgroundOrchestrator.sweep()

    const job = await BackgroundJob.get(id)
    expect(job?.status).toBe("exited")
    expect(job?.time.lost).toBeGreaterThan(0)
    expect(await Owed.pending("ses_orchestrator_undeliverable")).toBe(false)
  }, 20_000)

  // A delivery that throws is kept for later passes and recorded lost only
  // after repeated failures; the jobs behind it in the same pass are reached.
  test("a job whose delivery throws does not stop the jobs behind it", async () => {
    const project = await tmpdir({ git: true })
    const first = await ended("ses_orchestrator_before_throw", project.path)
    // No command: rendering the result throws inside the delivery.
    const middle = await ended("ses_orchestrator_throws", project.path, { command: undefined })
    const last = await ended("ses_orchestrator_after_throw", project.path)

    Recovery.start()
    await BackgroundOrchestrator.sweep()

    for (const id of [first, last]) expect((await BackgroundJob.get(id))?.time.lost).toBeGreaterThan(0)
    expect(await Owed.pending("ses_orchestrator_before_throw")).toBe(false)
    expect(await Owed.pending("ses_orchestrator_after_throw")).toBe(false)
    expect((await BackgroundJob.get(middle))?.time.lost).toBeUndefined()
    expect(await Owed.pending("ses_orchestrator_throws")).toBe(true)

    await Recovery.poke()
    await Recovery.poke()

    expect((await BackgroundJob.get(middle))?.time.lost).toBeGreaterThan(0)
    expect(await Owed.pending("ses_orchestrator_throws")).toBe(false)
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
    await Owed.add(id, "ses_orchestrator_orphan")

    const pass = await BackgroundReconcile.run({ alive: () => true })

    expect(pass.actions.find((entry) => entry.job.id === id)?.type).toBe("reaped")
    expect(await Owed.pending("ses_orchestrator_orphan")).toBe(false)
  })

  test("goes with a job whose owner is gone", async () => {
    const owner = await owned()
    const proc = spawnJob("sleep 30")
    const job = await store(proc.pid, owner)
    await Owed.add(job.id, owner.id)

    const pass = await BackgroundReconcile.run({ alive: gone })

    expect(pass.actions.find((entry) => entry.job.id === job.id)?.type).toBe("reaped")
    expect(await Owed.pending(owner.id)).toBe(false)
  }, 20_000)
})

describe("BackgroundOrchestrator settle window", () => {
  // The window has to outlast the asynchronous rebuild of session liveness
  // (re-arming daemons, resuming interrupted turns) and still end well before
  // the first scheduled sweep, so the first ownership verdict is taken on a
  // view that is real.
  test("ends before the first scheduled sweep would run", () => {
    expect(BackgroundOrchestrator.SETTLE_MS).toBeLessThan(BackgroundOrchestrator.SWEEP_MS)
  })

  test("is long enough to cover a restart's liveness rebuild", () => {
    expect(BackgroundOrchestrator.SETTLE_MS).toBeGreaterThanOrEqual(30_000)
  })

  // A sweep can be fired by the abort route or the exit watcher at any moment,
  // including seconds into the window, so the deferral is time-based rather
  // than a flag the boot path sets.
  test("defers ownership for any caller inside the window, not just the boot one", async () => {
    const proc = spawnJob("sleep 30")
    const job = await store(proc.pid, await owned())

    // No adopting flag: this is what the abort route's sweep looks like.
    await BackgroundOrchestrator.sweep()

    expect(await BackgroundJob.get(job.id)).toBeDefined()
    expect(await BackgroundProcess.verify(job.process!)).toBe("alive")
  }, 20_000)
})

// The nudge is delivered on its own timer, reading the running set off disk and
// claiming each due job. A job past its soft deadline gets exactly one nudge per
// call, stamped on the record so the next call paces off it.
describe("BackgroundOrchestrator.nudgeAll", () => {
  test("nudges a running job past its soft deadline and stamps it", async () => {
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

describe("BackgroundOrchestrator.sweep at boot", () => {
  test("adopts a job whose session cannot be resolved yet", async () => {
    const proc = spawnJob("sleep 30")
    const job = await store(proc.pid, await owned())

    await BackgroundOrchestrator.sweep({ adopting: true })

    expect(await BackgroundJob.get(job.id)).toBeDefined()
    expect(await BackgroundProcess.verify(job.process!)).toBe("alive")
  }, 20_000)

  // The same record IS reaped once ownership is judged, which is what makes the
  // test above say something: a fixture that survives every verdict would pass
  // it whether or not the window defers anything.
  //
  // The verdict is injected, because the window suppresses the ANSWER rather
  // than one predicate's opinion: `sweep({ adopting: true })` substitutes
  // `() => true` for whatever it was given, so a `false` reaching the
  // reconciler here is the same `false` the window swallows there.
  test("reaps that same job once ownership is judged", async () => {
    const proc = spawnJob("sleep 30")
    const job = await store(proc.pid, await owned())

    const pass = await BackgroundReconcile.run({ alive: gone })
    const action = pass.actions.find((entry) => entry.job.id === job.id)

    expect(action?.type).toBe("reaped")
    expect(await BackgroundJob.get(job.id)).toBeUndefined()
    expect(await BackgroundProcess.verify(job.process!)).not.toBe("alive")
  }, 20_000)
})
