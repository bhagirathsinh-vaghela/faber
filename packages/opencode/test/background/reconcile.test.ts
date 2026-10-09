import { describe, expect, test, afterEach } from "bun:test"
import { BackgroundJob } from "../../src/background/job"
import { BackgroundProcess } from "../../src/background/process"
import { BackgroundReconcile } from "../../src/background/reconcile"

const created: string[] = []

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
    const proc = spawnJob("sleep 0.3")
    const job = await store({ process: await identify(proc.pid) })
    await proc.exited
    await Bun.write(BackgroundJob.exitPath(job.id), "0\n")

    const action = actionFor(await BackgroundReconcile.run(), job.id)

    expect(action?.type).toBe("completed")
    expect(action?.type === "completed" && action.exit).toBe(0)
    const record = await BackgroundJob.get(job.id)
    expect(record?.status).toBe("exited")
    expect(record?.exit).toBe(0)
    expect(record?.ended).toBeUndefined()
  })

  // The recovery path the whole subsystem exists for: a job self-timed out via
  // its own watchdog WHILE THE SERVER WAS DOWN, so its process is already gone
  // and its exit file carries the watchdog's rc past the deadline. A reconciling
  // server must call this a timeout, not a plain failure — the same verdict the
  // live handle reaches, on the sibling path.
  test("calls a job that self-timed-out while nobody watched a timeout, not a failure", async () => {
    const proc = spawnJob("sleep 0.3")
    const job = await store({
      process: await identify(proc.pid),
      time: { created: Date.now() - 7200_000, hard: Date.now() - 3600_000 },
    })
    await proc.exited
    // The watchdog's exit code, written now — so the exit file's mtime is past
    // the deadline set above, which is what marks the end as a timeout.
    await Bun.write(BackgroundJob.exitPath(job.id), "143\n")

    const action = actionFor(await BackgroundReconcile.run(), job.id)

    expect(action?.type).toBe("expired")
    const record = await BackgroundJob.get(job.id)
    expect(record?.status).toBe("killed")
    expect(record?.ended).toBe("timeout")
    expect(record?.exit).toBe(143)
  })

  // The false positive the mtime guards against: a job that finished NORMALLY
  // before its deadline but is only reconciled long after it. Judging against a
  // pass's own clock would call this a timeout; judging against when the job
  // ended keeps it a clean completion.
  test("keeps a normal early finish a completion, however late the pass runs", async () => {
    const proc = spawnJob("sleep 0.3")
    const job = await store({
      process: await identify(proc.pid),
      // Deadline far in the future, so the exit file written now ends well
      // before it: a normal finish, not a timeout.
      time: { created: Date.now(), hard: Date.now() + 3600_000 },
    })
    await proc.exited
    await Bun.write(BackgroundJob.exitPath(job.id), "0\n")

    const action = actionFor(await BackgroundReconcile.run(), job.id)

    expect(action?.type).toBe("completed")
    expect((await BackgroundJob.get(job.id))?.status).toBe("exited")
  })

  test("adopts a job still running inside its deadline and leaves it alone", async () => {
    const proc = spawnJob("sleep 30")
    const job = await store({ process: await identify(proc.pid) })

    const action = actionFor(await BackgroundReconcile.run(), job.id)

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

    const action = actionFor(await BackgroundReconcile.run(), job.id)

    expect(action?.type).toBe("expired")
    expect(await BackgroundProcess.verify(job.process!)).not.toBe("alive")
    const record = await BackgroundJob.get(job.id)
    expect(record?.status).toBe("killed")
    expect(record?.ended).toBe("timeout")
  })
})

describe("BackgroundReconcile: ownership", () => {
  // No session is consulted: a job whose session does not exist, or is idle,
  // or was stopped, is kept while it runs inside its bound. Stopping a job is
  // the stop path's decision, never a pass's.
  test("keeps a running job whose session does not exist", async () => {
    const proc = spawnJob("sleep 30")
    const job = await store({ process: await identify(proc.pid), sessionID: "ses_reconcile_no_such_session" })

    const action = actionFor(await BackgroundReconcile.run(), job.id)

    expect(action?.type).toBe("kept")
    expect(await BackgroundProcess.verify(job.process!)).toBe("alive")
    expect((await BackgroundJob.get(job.id))?.status).toBe("running")
  })
})

describe("BackgroundReconcile: records with nothing behind them", () => {
  // The server died between writing the record and the spawn returning.
  test("discards a record whose spawn never landed", async () => {
    const job = await store({ process: undefined })

    const action = actionFor(await BackgroundReconcile.run(), job.id)

    expect(action?.type).toBe("reaped")
    expect(action?.type === "reaped" && action.reason).toBe("orphaned")
    expect(await BackgroundJob.get(job.id)).toBeUndefined()
  })

  // A reused pid is unreachable, not killable: the pass must not signal it.
  test("settles a job whose pid was reused without signalling the stranger", async () => {
    const proc = spawnJob("sleep 30")
    const identity = await identify(proc.pid)
    const job = await store({ process: { ...identity, start: "Mon Jan  1 00:00:00 2001" } })

    const action = actionFor(await BackgroundReconcile.run(), job.id)

    expect(action?.type).toBe("completed")
    expect(await BackgroundProcess.inspect(proc.pid)).toBeDefined()

    process.kill(-proc.pid, "SIGKILL")
    await proc.exited
  })

  test("ignores a record that already finished", async () => {
    const job = await store({ status: "exited", exit: 0, time: { created: 0, hard: 0, completed: Date.now() } })

    expect(actionFor(await BackgroundReconcile.run(), job.id)).toBeUndefined()
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

    const started = Date.now()
    while (!finished.includes(id) && Date.now() - started < 5_000) {
      // Exactly what the job's last line does. Re-written each poll: fs.watch
      // can drop a notification for a write that lands right after the stream
      // opens, so one write is not a reliable trigger.
      await Bun.write(BackgroundJob.exitPath(id), "0\n")
      await Bun.sleep(50)
    }

    BackgroundReconcile.unobserve()
    await BackgroundJob.remove(id)
    expect(finished).toContain(id)
  }, 15_000)

  test("ignores the log file, which is written throughout the run", async () => {
    await BackgroundJob.init()
    const logId = BackgroundJob.id()
    const exitId = BackgroundJob.id()

    const finished: string[] = []
    BackgroundReconcile.observe((seen) => void finished.push(seen))

    // A `.log` for the id under test, and a `.exit` for a DIFFERENT id. The exit
    // is what proves the watcher is live: without it, a dropped event and a
    // correctly-ignored `.log` are indistinguishable, so the negative assertion
    // could pass for the wrong reason. The exit id is re-written each poll for
    // the same reason the firing tests are — fs.watch can drop the first event.
    await Bun.write(BackgroundJob.logPath(logId), "progress output\n")
    const started = Date.now()
    while (!finished.includes(exitId) && Date.now() - started < 5_000) {
      await Bun.write(BackgroundJob.exitPath(exitId), "0\n")
      await Bun.sleep(50)
    }

    BackgroundReconcile.unobserve()
    await BackgroundJob.remove(logId)
    await BackgroundJob.remove(exitId)
    // The watcher fired for the exit file, proving it is live...
    expect(finished).toContain(exitId)
    // ...and did NOT fire for the log id, which is the actual assertion.
    expect(finished).not.toContain(logId)
  }, 10_000)

  // The event is a wake-up carrying an id, so the id it reports must be the
  // job's own rather than a filename the caller has to parse.
  test("reports the job id rather than the file it saw", async () => {
    await BackgroundJob.init()
    const id = BackgroundJob.id()

    const finished: string[] = []
    BackgroundReconcile.observe((seen) => void finished.push(seen))

    const started = Date.now()
    while (!finished.includes(id) && Date.now() - started < 5_000) {
      await Bun.write(BackgroundJob.exitPath(id), "0\n")
      await Bun.sleep(50)
    }
    BackgroundReconcile.unobserve()
    await BackgroundJob.remove(id)

    expect(finished).toContain(id)
    expect(finished.some((seen) => seen.endsWith(".exit"))).toBe(false)
  }, 15_000)
})

// Past the soft deadline the reconcile pass only keeps a running job; the
// nudge itself fires on its own timer and is tested in job.test.ts against
// BackgroundJob.nudge.
describe("BackgroundReconcile: past the soft deadline", () => {
  test("keeps a running job rather than acting on the soft deadline", async () => {
    const proc = spawnJob("sleep 30")
    const job = await store({
      process: await identify(proc.pid),
      time: { created: Date.now() - 60_000, soft: Date.now() - 30_000, hard: Date.now() + 600_000 },
    })

    expect(actionFor(await BackgroundReconcile.run(), job.id)?.type).toBe("kept")
    expect(await BackgroundProcess.verify(job.process!)).toBe("alive")
  })
})

// Nothing serialises two passes: the exit watcher and the abort route both
// sweep unguarded, and the scheduler's tick is not re-entrant. Two passes that
// both read a running record and both settle it deliver the same result twice,
// which reaches the session as two cards for one job.
describe("BackgroundReconcile concurrency", () => {
  test("only one of two simultaneous passes may complete a job", async () => {
    // Identified while alive, then allowed to exit: a pass assesses this as
    // finished, which is the branch that settles and delivers.
    const proc = spawnJob("sleep 0.5")
    const process = await identify(proc.pid)
    await proc.exited
    const job = await store({ process })

    // Started together, so both observe the record while it is still running.
    const passes = await Promise.all([BackgroundReconcile.run(), BackgroundReconcile.run()])

    const completed = passes.filter((pass) => actionFor(pass, job.id)?.type === "completed")
    expect(completed.length).toBe(1)
  }, 20_000)
})
