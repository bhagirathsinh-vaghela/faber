import { describe, expect, test, afterEach } from "bun:test"
import { BackgroundJob } from "../../src/background/job"
import { BackgroundProcess } from "../../src/background/process"
import { BackgroundSpawn } from "../../src/background/spawn"

const spawned: string[] = []

async function run(command: string, options: Partial<BackgroundSpawn.Input> = {}) {
  const result = await BackgroundSpawn.run({
    command,
    description: "test",
    sessionID: "ses_spawn_test",
    directory: "/tmp",
    shell: "/bin/sh",
    env: {},
    hard: 60_000,
    ...options,
  })
  spawned.push(result.job.id)
  return result
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
    const result = await run("echo hello")

    expect(result.type).toBe("inline")
    expect(Date.now() - started).toBeLessThan(BackgroundSpawn.GRACE_MS)
    if (result.type !== "inline") throw new Error("expected inline")
    expect(result.output).toContain("hello")
    expect(result.exit).toBe(0)
  })

  test("carries a failing command's exit code", async () => {
    const result = await run("echo nope >&2; exit 3")
    expect(result.type).toBe("inline")
    if (result.type !== "inline") throw new Error("expected inline")
    expect(result.exit).toBe(3)
    expect(result.output).toContain("nope")
  })

  test("marks the record exited so a later sweep leaves it alone", async () => {
    const result = await run("true")
    const job = await BackgroundJob.get(result.job.id)
    expect(job?.status).toBe("exited")
    expect(job?.time.completed).toBeDefined()
  })
})

describe("BackgroundSpawn background path", () => {
  test("a slow command hands back a task id at the grace window", async () => {
    const started = Date.now()
    const result = await run("sleep 30")
    const elapsed = Date.now() - started

    expect(result.type).toBe("background")
    expect(elapsed).toBeGreaterThanOrEqual(BackgroundSpawn.GRACE_MS - 500)
    expect(elapsed).toBeLessThan(BackgroundSpawn.GRACE_MS + 5_000)
    expect(result.job.status).toBe("running")
  }, 20_000)

  test("the job keeps running and its identity is recorded", async () => {
    const result = await run("sleep 30")
    const job = (await BackgroundJob.get(result.job.id))!

    expect(job.process).toBeDefined()
    expect(await BackgroundProcess.verify(job.process!)).toBe("alive")
    // Spawned detached, so the job leads its own group.
    expect(job.process!.pgid).toBe(job.process!.pid)
  }, 20_000)

  // Output must be readable WHILE the job runs, which is what makes progress
  // a plain `tail` rather than a new tool.
  test("output is on disk and growing before the job finishes", async () => {
    const result = await run("echo first; sleep 30")
    expect(result.type).toBe("background")
    expect(await BackgroundJob.output(result.job.id)).toContain("first")
  }, 20_000)
})

describe("BackgroundSpawn durability", () => {
  // Written before the spawn, so a crash in between leaves a findable record
  // rather than an unfindable process.
  test("the record exists with its log path derivable from the id alone", async () => {
    const result = await run("sleep 30")
    const job = (await BackgroundJob.get(result.job.id))!

    expect(job.id).toBe(result.job.id)
    expect(BackgroundJob.logPath(job.id)).toContain(job.id)
    expect(await Bun.file(BackgroundJob.logPath(job.id)).exists()).toBe(true)
  }, 20_000)

  // The bound is an instant on disk, so it survives the process that set it.
  test("stores the hard deadline as an absolute instant, not a timer", async () => {
    const before = Date.now()
    const result = await run("sleep 30", { hard: 60_000 })
    const job = (await BackgroundJob.get(result.job.id))!

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
    const result = await run("read line; echo \"got:$line\"")

    expect(result.type).toBe("inline")
    expect(Date.now() - started).toBeLessThan(BackgroundSpawn.GRACE_MS)
    if (result.type !== "inline") throw new Error("expected inline")
    expect(result.output).toContain("got:")
  })
})
