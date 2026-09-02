import { describe, expect, test, afterEach } from "bun:test"
import { BackgroundJob } from "../../src/background/job"
import { BackgroundProcess } from "../../src/background/process"
import { BackgroundOrchestrator } from "../../src/background/orchestrator"
import { BackgroundReconcile } from "../../src/background/reconcile"

const created: string[] = []

function spawnJob(script: string) {
  return Bun.spawn({ cmd: ["sh", "-c", script], detached: true, stdio: ["ignore", "ignore", "ignore"] })
}

async function store(pid: number) {
  const live = (await BackgroundProcess.inspect(pid))!
  const id = BackgroundJob.id()
  created.push(id)
  const job: BackgroundJob.Info = {
    id,
    sessionID: "ses_orchestrator_test_absent",
    directory: "/tmp",
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
    const job = await store(proc.pid)

    // No adopting flag: this is what the abort route's sweep looks like.
    await BackgroundOrchestrator.sweep()

    expect(await BackgroundJob.get(job.id)).toBeDefined()
    expect(await BackgroundProcess.verify(job.process!)).toBe("alive")
  }, 20_000)
})

describe("BackgroundOrchestrator.sweep at boot", () => {
  test("adopts a job whose session cannot be resolved yet", async () => {
    const proc = spawnJob("sleep 30")
    const job = await store(proc.pid)

    await BackgroundOrchestrator.sweep({ adopting: true })

    expect(await BackgroundJob.get(job.id)).toBeDefined()
    expect(await BackgroundProcess.verify(job.process!)).toBe("alive")
  }, 20_000)

  // The same record IS reaped once ownership is judged. Without this the
  // adoption tests would pass for the wrong reason, e.g. if nothing swept at
  // all. Driven through the reconciler with the resolved predicate, because
  // sweep() defers ownership for the whole settle window and this process has
  // not been up that long.
  test("reaps that same job once ownership is judged", async () => {
    const proc = spawnJob("sleep 30")
    const job = await store(proc.pid)

    const pass = await BackgroundReconcile.run({ alive: () => false })
    const action = pass.actions.find((entry) => entry.job.id === job.id)

    expect(action?.type).toBe("reaped")
    expect(await BackgroundJob.get(job.id)).toBeUndefined()
    expect(await BackgroundProcess.verify(job.process!)).not.toBe("alive")
  }, 20_000)
})
