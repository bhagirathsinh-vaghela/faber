import { describe, expect, test, afterEach } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { BackgroundJob } from "../../src/background/job"
import { BackgroundProcess } from "../../src/background/process"
import { BackgroundOrchestrator } from "../../src/background/orchestrator"
import { BackgroundReconcile } from "../../src/background/reconcile"
import { tmpdir } from "../fixture/fixture"

const created: string[] = []

function spawnJob(script: string) {
  return Bun.spawn({ cmd: ["sh", "-c", script], detached: true, stdio: ["ignore", "ignore", "ignore"] })
}

// A session the predicate REAPS: it resolves (so the answer is knowable), was
// never armed, and is not in the recent list, which is `false` — the user let
// it go. An id that does not resolve reads as undefined and is kept whatever
// the window does, so a job stored under one cannot show the window working.
async function reapable() {
  const tmp = await tmpdir({ git: true })
  const id = await Instance.provide({
    directory: tmp.path,
    fn: async () => (await Session.createNext({ directory: tmp.path, title: "orchestrator test" })).id,
  })
  expect(await BackgroundOrchestrator.aliveFor(id, tmp.path)).toBe(false)
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
  }
})

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
    const owner = await reapable()
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
    const owner = await reapable()
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
    expect(await BackgroundOrchestrator.aliveFor(job.sessionID, BackgroundJob.owner(job))).toBe(false)
    expect(await BackgroundOrchestrator.aliveFor(job.sessionID, job.directory)).toBeUndefined()
  })
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
    const job = await store(proc.pid, await reapable())

    // No adopting flag: this is what the abort route's sweep looks like.
    await BackgroundOrchestrator.sweep()

    expect(await BackgroundJob.get(job.id)).toBeDefined()
    expect(await BackgroundProcess.verify(job.process!)).toBe("alive")
  }, 20_000)
})

describe("BackgroundOrchestrator.sweep at boot", () => {
  test("adopts a job whose session cannot be resolved yet", async () => {
    const proc = spawnJob("sleep 30")
    const job = await store(proc.pid, await reapable())

    await BackgroundOrchestrator.sweep({ adopting: true })

    expect(await BackgroundJob.get(job.id)).toBeDefined()
    expect(await BackgroundProcess.verify(job.process!)).toBe("alive")
  }, 20_000)

  // The same record IS reaped once ownership is judged, which is what makes the
  // two tests above say something: a fixture that survives every verdict would
  // pass them whether or not the window defers anything.
  //
  // Driven through the reconciler with the ORCHESTRATOR'S OWN predicate rather
  // than an injected `() => false`: the pair only holds if the same predicate
  // that reaps here is the one the window is suppressing there.
  test("reaps that same job once ownership is judged", async () => {
    const proc = spawnJob("sleep 30")
    const job = await store(proc.pid, await reapable())

    const pass = await BackgroundReconcile.run({ alive: BackgroundOrchestrator.aliveFor })
    const action = pass.actions.find((entry) => entry.job.id === job.id)

    expect(action?.type).toBe("reaped")
    expect(await BackgroundJob.get(job.id)).toBeUndefined()
    expect(await BackgroundProcess.verify(job.process!)).not.toBe("alive")
  }, 20_000)
})
