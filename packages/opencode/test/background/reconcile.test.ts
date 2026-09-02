import { describe, expect, test, afterEach } from "bun:test"
import { BackgroundJob } from "../../src/background/job"
import { BackgroundProcess } from "../../src/background/process"
import { BackgroundReconcile } from "../../src/background/reconcile"

const created: string[] = []
const alive = () => true
const dead = () => false

function spawnJob(script: string) {
  return Bun.spawn({ cmd: ["sh", "-c", script], detached: true, stdio: ["ignore", "ignore", "ignore"] })
}

async function identify(pid: number) {
  const live = (await BackgroundProcess.inspect(pid))!
  return { pid: live.pid, start: live.start, pgid: live.pgid }
}

async function store(overrides: Partial<BackgroundJob.Info> = {}) {
  const id = BackgroundJob.id()
  created.push(id)
  const job: BackgroundJob.Info = {
    id,
    sessionID: "ses_reconcile_test",
    directory: "/tmp",
    command: "sleep 30",
    description: "test job",
    status: "running",
    time: { created: Date.now(), hard: Date.now() + 600_000 },
    ...overrides,
  }
  await BackgroundJob.write(job)
  return job
}

// The pass only ever reports actions for records it touched, so a shared
// storage dir with unrelated jobs cannot make an assertion pass by accident.
function actionFor(pass: BackgroundReconcile.Pass, id: string) {
  return pass.actions.find((action) => action.job.id === id)
}

afterEach(async () => {
  for (const id of created.splice(0)) {
    const job = await BackgroundJob.get(id)
    if (job?.process) await BackgroundProcess.kill(job.process)
    await BackgroundJob.remove(id)
  }
})

describe("BackgroundReconcile: a job that outlived the server", () => {
  // The ordinary case after a restart: the job finished while nothing was
  // watching, and its result is sitting on disk.
  test("collects a job that exited while nobody was watching", async () => {
    const proc = spawnJob("true")
    const job = await store({ process: await identify(proc.pid) })
    await proc.exited
    await Bun.write(BackgroundJob.exitPath(job.id), "0\n")

    const action = actionFor(await BackgroundReconcile.run({ alive }), job.id)

    expect(action?.type).toBe("completed")
    expect(action?.type === "completed" && action.exit).toBe(0)
    expect((await BackgroundJob.get(job.id))?.status).toBe("exited")
  })

  test("adopts a job still running inside its deadline and leaves it alone", async () => {
    const proc = spawnJob("sleep 30")
    const job = await store({ process: await identify(proc.pid) })

    const action = actionFor(await BackgroundReconcile.run({ alive }), job.id)

    expect(action?.type).toBe("kept")
    expect(await BackgroundProcess.verify(job.process!)).toBe("alive")
  })

  // The deadline is an instant on disk, so a pass running long after it passed
  // still sees it as passed.
  test("kills a job past its hard deadline, however late the pass runs", async () => {
    const proc = spawnJob("sleep 30")
    const job = await store({
      process: await identify(proc.pid),
      time: { created: Date.now() - 7200_000, hard: Date.now() - 3600_000 },
    })

    const action = actionFor(await BackgroundReconcile.run({ alive }), job.id)

    expect(action?.type).toBe("expired")
    expect(await BackgroundProcess.verify(job.process!)).not.toBe("alive")
    expect((await BackgroundJob.get(job.id))?.status).toBe("killed")
  })
})

describe("BackgroundReconcile: ownership", () => {
  // A job whose session was stopped is work nobody will read.
  test("kills a healthy job whose owner is gone", async () => {
    const proc = spawnJob("sleep 30")
    const job = await store({ process: await identify(proc.pid) })

    const action = actionFor(await BackgroundReconcile.run({ alive: dead }), job.id)

    expect(action?.type).toBe("reaped")
    expect(action?.type === "reaped" && action.reason).toBe("owner-gone")
    expect(await BackgroundProcess.verify(job.process!)).not.toBe("alive")
    expect(await BackgroundJob.get(job.id)).toBeUndefined()
  })

  // The rule that lets a long build survive the turn that launched it.
  test("keeps a job running when its owner is alive, whatever the turn did", async () => {
    const proc = spawnJob("sleep 30")
    const job = await store({ process: await identify(proc.pid) })

    expect(actionFor(await BackgroundReconcile.run({ alive }), job.id)?.type).toBe("kept")
    expect(await BackgroundProcess.verify(job.process!)).toBe("alive")
  })

  test("consults liveness with the owning session id", async () => {
    const proc = spawnJob("sleep 30")
    const job = await store({ process: await identify(proc.pid), sessionID: "ses_specific_owner" })

    const asked: string[] = []
    await BackgroundReconcile.run({
      alive: (id) => {
        asked.push(id)
        return true
      },
    })

    expect(asked).toContain("ses_specific_owner")
  })
})

describe("BackgroundReconcile: the boot window", () => {
  // A pass that runs before session liveness has been rebuilt sees every
  // session as not alive, including ones whose turns are about to resume.
  // Reaping on that reading kills healthy jobs, so a boot pass adopts instead
  // and leaves the ownership call to a later one.
  test("adopts a running job instead of reaping it when ownership is deferred", async () => {
    const proc = spawnJob("sleep 30")
    const job = await store({ process: await identify(proc.pid) })

    // What the boot pass passes: ownership not yet knowable, so not judged.
    const action = actionFor(await BackgroundReconcile.run({ alive: () => true }), job.id)

    expect(action?.type).toBe("kept")
    expect(await BackgroundProcess.verify(job.process!)).toBe("alive")
    expect(await BackgroundJob.get(job.id)).toBeDefined()
  })

  // Deferring ownership must not defer anything derived from the job itself:
  // those verdicts come off disk and are correct immediately.
  test("still collects a finished job while ownership is deferred", async () => {
    const proc = spawnJob("true")
    const job = await store({ process: await identify(proc.pid) })
    await proc.exited
    await Bun.write(BackgroundJob.exitPath(job.id), "0\n")

    const action = actionFor(await BackgroundReconcile.run({ alive: () => true }), job.id)

    expect(action?.type).toBe("completed")
  })

  test("still kills a job past its deadline while ownership is deferred", async () => {
    const proc = spawnJob("sleep 30")
    const job = await store({
      process: await identify(proc.pid),
      time: { created: Date.now() - 7200_000, hard: Date.now() - 3600_000 },
    })

    const action = actionFor(await BackgroundReconcile.run({ alive: () => true }), job.id)

    expect(action?.type).toBe("expired")
    expect(await BackgroundProcess.verify(job.process!)).not.toBe("alive")
  })
})

describe("BackgroundReconcile: records with nothing behind them", () => {
  // The server died between writing the record and the spawn returning.
  test("discards a record whose spawn never landed", async () => {
    const job = await store({ process: undefined })

    const action = actionFor(await BackgroundReconcile.run({ alive }), job.id)

    expect(action?.type).toBe("reaped")
    expect(action?.type === "reaped" && action.reason).toBe("orphaned")
    expect(await BackgroundJob.get(job.id)).toBeUndefined()
  })

  // A reused pid is unreachable, not killable: the pass must not signal it.
  test("settles a job whose pid was reused without signalling the stranger", async () => {
    const proc = spawnJob("sleep 30")
    const identity = await identify(proc.pid)
    const job = await store({ process: { ...identity, start: "Mon Jan  1 00:00:00 2001" } })

    const action = actionFor(await BackgroundReconcile.run({ alive }), job.id)

    expect(action?.type).toBe("completed")
    expect(await BackgroundProcess.inspect(proc.pid)).toBeDefined()

    process.kill(-proc.pid, "SIGKILL")
    await proc.exited
  })

  test("ignores a record that already finished", async () => {
    const job = await store({ status: "exited", exit: 0, time: { created: 0, hard: 0, completed: Date.now() } })

    expect(actionFor(await BackgroundReconcile.run({ alive }), job.id)).toBeUndefined()
    expect(await BackgroundJob.get(job.id)).toBeDefined()
  })
})

describe("BackgroundReconcile.observe (adopted jobs)", () => {
  // A job this server never spawned leaves no handle to await. waitpid is
  // unavailable to a non-parent, and the syscalls that do report a non-child's
  // death are per-platform and report no exit code. The job's own exit file
  // answers both, portably.
  // These drive the watcher against the FILESYSTEM alone, with no stored
  // record: the watcher's whole job is to turn a file appearing into an id,
  // and a record here would only be shared state that a concurrent sweep in
  // another test file can delete mid-assertion.
  test("fires when an adopted job writes its exit file", async () => {
    await BackgroundJob.init()
    const id = BackgroundJob.id()

    const finished: string[] = []
    BackgroundReconcile.observe((seen) => void finished.push(seen))

    // Exactly what the job's last line does.
    await Bun.write(BackgroundJob.exitPath(id), "0\n")

    const started = Date.now()
    while (!finished.includes(id) && Date.now() - started < 5_000) await Bun.sleep(50)

    BackgroundReconcile.unobserve()
    await BackgroundJob.remove(id)
    expect(finished).toContain(id)
  }, 15_000)

  test("ignores the log file, which is written throughout the run", async () => {
    await BackgroundJob.init()
    const id = BackgroundJob.id()

    const finished: string[] = []
    BackgroundReconcile.observe((seen) => void finished.push(seen))

    await Bun.write(BackgroundJob.logPath(id), "progress output\n")
    await Bun.sleep(500)

    BackgroundReconcile.unobserve()
    await BackgroundJob.remove(id)
    expect(finished).not.toContain(id)
  }, 10_000)

  // The event is a wake-up carrying an id, so the id it reports must be the
  // job's own rather than a filename the caller has to parse.
  test("reports the job id rather than the file it saw", async () => {
    await BackgroundJob.init()
    const id = BackgroundJob.id()

    const finished: string[] = []
    BackgroundReconcile.observe((seen) => void finished.push(seen))
    await Bun.write(BackgroundJob.exitPath(id), "0\n")

    const started = Date.now()
    while (!finished.includes(id) && Date.now() - started < 5_000) await Bun.sleep(50)
    BackgroundReconcile.unobserve()
    await BackgroundJob.remove(id)

    expect(finished).toContain(id)
    expect(finished.some((seen) => seen.endsWith(".exit"))).toBe(false)
  }, 15_000)
})

describe("BackgroundReconcile: the soft check-in", () => {
  test("reports a check-in once the soft deadline passes, without killing", async () => {
    const proc = spawnJob("sleep 30")
    const job = await store({
      process: await identify(proc.pid),
      time: { created: Date.now() - 60_000, soft: Date.now() - 30_000, hard: Date.now() + 600_000 },
    })

    const action = actionFor(await BackgroundReconcile.run({ alive }), job.id)

    expect(action?.type).toBe("notify")
    expect(await BackgroundProcess.verify(job.process!)).toBe("alive")
  })

  // A pass runs every few minutes; without the stamp the same check-in would
  // arrive forever.
  test("delivers the check-in only once", async () => {
    const proc = spawnJob("sleep 30")
    const job = await store({
      process: await identify(proc.pid),
      time: { created: Date.now() - 60_000, soft: Date.now() - 30_000, hard: Date.now() + 600_000 },
    })

    expect(actionFor(await BackgroundReconcile.run({ alive }), job.id)?.type).toBe("notify")
    expect(actionFor(await BackgroundReconcile.run({ alive }), job.id)?.type).toBe("kept")
  })

  test("stays quiet before the soft deadline", async () => {
    const proc = spawnJob("sleep 30")
    const job = await store({
      process: await identify(proc.pid),
      time: { created: Date.now(), soft: Date.now() + 600_000, hard: Date.now() + 900_000 },
    })

    expect(actionFor(await BackgroundReconcile.run({ alive }), job.id)?.type).toBe("kept")
  })
})
