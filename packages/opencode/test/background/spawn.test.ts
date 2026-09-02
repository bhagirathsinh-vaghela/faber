import { describe, expect, test, afterEach } from "bun:test"
import { BackgroundJob } from "../../src/background/job"
import { BackgroundProcess } from "../../src/background/process"
import { BackgroundSpawn } from "../../src/background/spawn"

const spawned: string[] = []

async function run(command: string, options: Partial<BackgroundSpawn.Input> = {}) {
  const spawn = await BackgroundSpawn.run({
    command,
    description: "test",
    sessionID: "ses_spawn_test",
    directory: "/tmp",
    project: "/tmp",
    shell: "/bin/sh",
    env: {},
    hard: 60_000,
    ...options,
  })
  spawned.push(spawn.job.id)
  return spawn
}

afterEach(async () => {
  for (const id of spawned.splice(0)) {
    const job = await BackgroundJob.get(id)
    if (job?.process) await BackgroundProcess.kill(job.process)
    await BackgroundJob.remove(id)
  }
})

describe("BackgroundSpawn inline path", () => {
  // The property that keeps sequential read-decide-act chains in one turn.
  test("a fast command returns inline, well inside the grace window", async () => {
    const started = Date.now()
    const spawn = await run("echo hello")

    expect(spawn.type).toBe("inline")
    expect(Date.now() - started).toBeLessThan(BackgroundSpawn.GRACE_MS)
    if (spawn.type !== "inline") throw new Error("expected inline")
    expect(spawn.output).toContain("hello")
    expect(spawn.exit).toBe(0)
  })

  test("carries a failing command's exit code", async () => {
    const spawn = await run("echo nope >&2; exit 3")
    expect(spawn.type).toBe("inline")
    if (spawn.type !== "inline") throw new Error("expected inline")
    expect(spawn.exit).toBe(3)
    expect(spawn.output).toContain("nope")
  })

  test("marks the record exited so a later sweep leaves it alone", async () => {
    const spawn = await run("true")
    const job = await BackgroundJob.get(spawn.job.id)
    expect(job?.status).toBe("exited")
    expect(job?.time.completed).toBeDefined()
  })
})

describe("BackgroundSpawn background path", () => {
  test("a slow command hands back a task id at the grace window", async () => {
    const started = Date.now()
    const spawn = await run("sleep 30")
    const elapsed = Date.now() - started

    expect(spawn.type).toBe("background")
    expect(elapsed).toBeGreaterThanOrEqual(BackgroundSpawn.GRACE_MS - 500)
    expect(elapsed).toBeLessThan(BackgroundSpawn.GRACE_MS + 5_000)
    expect(spawn.job.status).toBe("running")
  }, 20_000)

  test("the job keeps running and its identity is recorded", async () => {
    const spawn = await run("sleep 30")
    const job = (await BackgroundJob.get(spawn.job.id))!

    expect(job.process).toBeDefined()
    expect(await BackgroundProcess.verify(job.process!)).toBe("alive")
    // Spawned detached, so the job leads its own group.
    expect(job.process!.pgid).toBe(job.process!.pid)
  }, 20_000)

  // Output must be readable WHILE the job runs, which is what makes progress
  // a plain `tail` rather than a new tool.
  test("output is on disk and growing before the job finishes", async () => {
    const spawn = await run("echo first; sleep 30")
    expect(spawn.type).toBe("background")
    expect(await BackgroundJob.output(spawn.job.id)).toContain("first")
  }, 20_000)
})

describe("BackgroundSpawn exit watcher", () => {
  // Without this the result of a job finishing just past the window would wait
  // for the next reconcile pass, which can be half an hour away. The handle is
  // already held in this process, so its exit costs no poller and no worker.
  test("fires the moment a backgrounded job exits", async () => {
    const seen: string[] = []
    BackgroundSpawn.watch((job) => void seen.push(job.id))

    // Must outlive the grace window, or it returns inline and the watcher is
    // correctly never involved.
    const spawn = await run("echo done-late; sleep 7")
    expect(spawn.type).toBe("background")

    const started = Date.now()
    while (!seen.includes(spawn.job.id) && Date.now() - started < 15_000) await Bun.sleep(100)

    expect(seen).toContain(spawn.job.id)
    BackgroundSpawn.watch(() => {})
  }, 35_000)

  test("hands the watcher a settled record carrying the exit code", async () => {
    const settled: Array<{ id: string; exit: number | undefined; status: string }> = []
    BackgroundSpawn.watch((job) => void settled.push({ id: job.id, exit: job.exit, status: job.status }))

    const spawn = await run("sleep 7; exit 5")
    const started = Date.now()
    while (!settled.some((j) => j.id === spawn.job.id) && Date.now() - started < 15_000) await Bun.sleep(100)

    const match = settled.find((j) => j.id === spawn.job.id)
    expect(match?.status).toBe("exited")
    expect(match?.exit).toBe(5)
    BackgroundSpawn.watch(() => {})
  }, 35_000)

  test("does not fire for a job that returned inline", async () => {
    const seen: string[] = []
    BackgroundSpawn.watch((job) => void seen.push(job.id))

    const spawn = await run("echo quick")
    await Bun.sleep(500)

    expect(seen).not.toContain(spawn.job.id)
    expect((await BackgroundJob.get(spawn.job.id))?.status).toBe("exited")
    BackgroundSpawn.watch(() => {})
  })
})

describe("BackgroundSpawn durability", () => {
  // Written before the spawn, so a crash in between leaves a findable record
  // rather than an unfindable process.
  test("the record exists with its log path derivable from the id alone", async () => {
    const spawn = await run("sleep 30")
    const job = (await BackgroundJob.get(spawn.job.id))!

    expect(job.id).toBe(spawn.job.id)
    expect(BackgroundJob.logPath(job.id)).toContain(job.id)
    expect(await Bun.file(BackgroundJob.logPath(job.id)).exists()).toBe(true)
  }, 20_000)

  // The bound is an instant on disk, so it survives the process that set it.
  test("stores the hard deadline as an absolute instant, not a timer", async () => {
    const before = Date.now()
    const spawn = await run("sleep 30", { hard: 60_000 })
    const job = (await BackgroundJob.get(spawn.job.id))!

    expect(job.time.hard).toBeGreaterThanOrEqual(before + 60_000)
    expect(job.time.hard).toBeLessThan(before + 70_000)
  }, 20_000)

  test("records a soft deadline only when one was asked for", async () => {
    const withSoft = await run("sleep 30", { soft: 10_000 })
    expect((await BackgroundJob.get(withSoft.job.id))!.time.soft).toBeDefined()

    const without = await run("true")
    expect((await BackgroundJob.get(without.job.id))!.time.soft).toBeUndefined()
  }, 25_000)
})

describe("BackgroundSpawn stdin", () => {
  // An interactive command must fail fast rather than hang forever against an
  // unbounded job. Closed stdin is what turns "waits for input that can never
  // arrive" into an immediate EOF.
  test("stdin is closed, so a command reading it finishes instead of hanging", async () => {
    const started = Date.now()
    const spawn = await run('read line; echo "got:$line"')

    expect(spawn.type).toBe("inline")
    expect(Date.now() - started).toBeLessThan(BackgroundSpawn.GRACE_MS)
    if (spawn.type !== "inline") throw new Error("expected inline")
    expect(spawn.output).toContain("got:")
  })
})

// Settling is what earns the right to deliver, so the guarded write and the
// answer have to agree. The exit watcher and a reconcile sweep are woken by the
// same event — the job ending — so both reach the settle for one job as a matter
// of course, and a settle that answers regardless of its own claim puts two
// results in the session for one job.
describe("BackgroundSpawn: one job settles once", () => {
  test("the exit watcher stays silent for a job another pass already settled", async () => {
    const fired: string[] = []
    BackgroundSpawn.watch(async (job) => {
      fired.push(job.id)
    })

    const spawn = await run(`sleep ${BackgroundSpawn.GRACE_MS / 1000 + 1}`)
    expect(spawn.type).toBe("background")

    // Exactly what a sweep does when it finds the process gone: take the record
    // out of `running` before the exit handle wakes.
    await BackgroundJob.update(spawn.job.id, (draft) => {
      draft.status = "exited"
      draft.exit = 0
      draft.time.completed = Date.now()
    })

    const started = Date.now()
    while (Date.now() - started < 4_000) {
      if (fired.includes(spawn.job.id)) break
      await Bun.sleep(50)
    }

    expect(fired.filter((id) => id === spawn.job.id).length).toBe(0)
    BackgroundSpawn.watch(() => {})
  }, 25_000)
})
