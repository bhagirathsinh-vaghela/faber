import { describe, expect, test, afterEach } from "bun:test"
import fs from "fs/promises"
import { BackgroundJob } from "../../src/background/job"

const created: string[] = []

function record(overrides: Partial<BackgroundJob.Info> = {}): BackgroundJob.Info {
  const id = BackgroundJob.id()
  created.push(id)
  return {
    id,
    sessionID: "ses_test",
    directory: "/tmp",
    command: "echo hi",
    description: "test job",
    status: "running",
    time: { created: Date.now(), hard: Date.now() + 60_000 },
    ...overrides,
  }
}

afterEach(async () => {
  for (const id of created.splice(0)) await BackgroundJob.remove(id)
})

// Spawned the way a real job is: detached, so it leads its own process group.
function spawnJob(script: string) {
  return Bun.spawn({ cmd: ["sh", "-c", script], detached: true, stdio: ["ignore", "ignore", "ignore"] })
}

async function identify(pid: number) {
  const { BackgroundProcess } = await import("../../src/background/process")
  const live = (await BackgroundProcess.inspect(pid))!
  return { pid: live.pid, start: live.start, pgid: live.pgid }
}

describe("BackgroundJob record", () => {
  test("round-trips through storage and appears in the listing", async () => {
    const job = record()
    await BackgroundJob.write(job)

    expect(await BackgroundJob.get(job.id)).toEqual(job)
    expect((await BackgroundJob.list()).map((j) => j.id)).toContain(job.id)
  })

  // The property the whole design rests on: a record written by one server is
  // readable by the next one, since it lives on disk and not in Instance.state.
  test("a record written earlier is readable with no in-memory state", async () => {
    const job = record({
      status: "exited",
      exit: 0,
      time: { created: Date.now(), hard: Date.now(), completed: Date.now() },
    })
    await BackgroundJob.write(job)

    const fresh = await BackgroundJob.get(job.id)
    expect(fresh?.status).toBe("exited")
    expect(fresh?.exit).toBe(0)
  })

  test("ids sort oldest-first, so listing needs no stat call", () => {
    const ids = [BackgroundJob.id(), BackgroundJob.id(), BackgroundJob.id()]
    expect([...ids].sort()).toEqual(ids)
  })

  test("update mutates in place and remove deletes the record and its files", async () => {
    const job = record()
    await BackgroundJob.write(job)
    await Bun.write(BackgroundJob.logPath(job.id), "some output")
    await Bun.write(BackgroundJob.exitPath(job.id), "0\n")

    await BackgroundJob.update(job.id, (draft) => {
      draft.status = "exited"
    })
    expect((await BackgroundJob.get(job.id))?.status).toBe("exited")

    await BackgroundJob.remove(job.id)
    expect(await BackgroundJob.get(job.id)).toBeUndefined()
    expect(await Bun.file(BackgroundJob.logPath(job.id)).exists()).toBe(false)
    expect(await Bun.file(BackgroundJob.exitPath(job.id)).exists()).toBe(false)
  })
})

describe("BackgroundJob.exit", () => {
  test("reads the code the job recorded for itself", async () => {
    const job = record()
    await Bun.write(BackgroundJob.exitPath(job.id), "42\n")
    expect(await BackgroundJob.exit(job.id)).toBe(42)
  })

  // A SIGKILLed job never reaches its own exit write, so the file is absent.
  // That absence is information, not an error to paper over.
  test("undefined when the job died before recording a status", async () => {
    const job = record()
    expect(await BackgroundJob.exit(job.id)).toBeUndefined()
  })
})

describe("BackgroundJob.assess", () => {
  test("running while the process is alive and inside its deadline", async () => {
    const proc = spawnJob("sleep 5")
    const job = record({ process: await identify(proc.pid) })

    expect((await BackgroundJob.assess(job)).type).toBe("running")

    process.kill(-proc.pid, "SIGKILL")
    await proc.exited
  })

  // The deadline is an absolute instant on disk, so a server that was down
  // when it passed still sees it as passed.
  test("expired once the hard deadline is behind us, however late the check runs", async () => {
    const proc = spawnJob("sleep 5")
    const job = record({
      process: await identify(proc.pid),
      time: { created: Date.now() - 7200_000, hard: Date.now() - 3600_000 },
    })

    const verdict = await BackgroundJob.assess(job)
    expect(verdict.type).toBe("expired")

    process.kill(-proc.pid, "SIGKILL")
    await proc.exited
  })

  test("finished, carrying the recorded exit code, once the process is gone", async () => {
    const proc = spawnJob("true")
    const job = record({ process: await identify(proc.pid) })
    await proc.exited
    await Bun.write(BackgroundJob.exitPath(job.id), "0\n")

    expect(await BackgroundJob.assess(job)).toEqual({ type: "finished", exit: 0 })
  })

  // A pid that now belongs to something else is unreachable, never killable.
  test("finished rather than expired when the pid was reused", async () => {
    const proc = spawnJob("sleep 5")
    const identity = await identify(proc.pid)
    const job = record({
      process: { ...identity, start: "Mon Jan  1 00:00:00 2001" },
      time: { created: Date.now() - 7200_000, hard: Date.now() - 3600_000 },
    })

    expect((await BackgroundJob.assess(job)).type).toBe("finished")

    // The real process is untouched by the assessment.
    const { BackgroundProcess } = await import("../../src/background/process")
    expect(await BackgroundProcess.inspect(proc.pid)).toBeDefined()
    process.kill(-proc.pid, "SIGKILL")
    await proc.exited
  })

  // The server died between writing the record and the spawn returning.
  test("orphaned when the record never learned a pid", async () => {
    expect((await BackgroundJob.assess(record())).type).toBe("orphaned")
  })

  test("finished for any record already past running", async () => {
    const job = record({ status: "killed", exit: 137 })
    expect(await BackgroundJob.assess(job)).toEqual({ type: "finished", exit: 137 })
  })
})

describe("BackgroundJob.cleanup", () => {
  test("reaps a finished job past the age cap and keeps a recent one", async () => {
    const now = Date.now()
    const stale = record({
      status: "exited",
      time: { created: 0, hard: 0, completed: now - BackgroundJob.MAX_AGE_MS - 1 },
    })
    const fresh = record({ status: "exited", time: { created: 0, hard: 0, completed: now } })
    await BackgroundJob.write(stale)
    await BackgroundJob.write(fresh)

    await BackgroundJob.cleanup(now)

    expect(await BackgroundJob.get(stale.id)).toBeUndefined()
    expect(await BackgroundJob.get(fresh.id)).toBeDefined()
  })

  // A long build must survive the cleanup that runs while it is still going.
  test("never reaps a running job, however old", async () => {
    const old = record({ time: { created: 0, hard: Date.now() + 60_000 } })
    await BackgroundJob.write(old)

    await BackgroundJob.cleanup(Date.now())

    expect(await BackgroundJob.get(old.id)).toBeDefined()
  })
})

describe("BackgroundJob.wrap", () => {
  // Run the wrapper the way the spawner does, with output to the log file.
  async function run(command: string, id: string, hardMs: number) {
    await BackgroundJob.init()
    const fd = await fs.open(BackgroundJob.logPath(id), "a")
    const proc = Bun.spawn({
      cmd: ["sh", "-c", BackgroundJob.wrap(command, id, hardMs)],
      detached: true,
      stdio: ["ignore", fd.fd, fd.fd],
    })
    const code = await proc.exited
    await fd.close()
    return code
  }

  test("passes a normal command's exit code through and records it", async () => {
    const job = record()
    expect(await run("echo hello; exit 7", job.id, 60_000)).toBe(7)
    expect(await BackgroundJob.output(job.id)).toContain("hello")
    expect(await BackgroundJob.exit(job.id)).toBe(7)
  })

  // The bound holds with no server involved at all: the job kills itself.
  test("kills itself at the hard deadline with no server participation", async () => {
    const job = record()
    const started = Date.now()
    const code = await run("echo starting; sleep 30", job.id, 1000)
    const elapsed = Date.now() - started

    expect(elapsed).toBeLessThan(10_000)
    expect(code).not.toBe(0)
    // Whatever the command wrote before the kill is still there.
    expect(await BackgroundJob.output(job.id)).toContain("starting")
    expect(await BackgroundJob.exit(job.id)).toBe(143)
  }, 20_000)

  test("takes the whole subtree, not just the direct child", async () => {
    const job = record()
    await BackgroundJob.init()
    const fd = await fs.open(BackgroundJob.logPath(job.id), "a")
    const proc = Bun.spawn({
      cmd: ["sh", "-c", BackgroundJob.wrap("sleep 30 & echo $!; sleep 30", job.id, 1000)],
      detached: true,
      stdio: ["ignore", fd.fd, fd.fd],
    })
    await proc.exited
    await fd.close()

    const grandchild = Number((await BackgroundJob.output(job.id)).trim().split("\n")[0])
    expect(grandchild).toBeGreaterThan(0)

    const { BackgroundProcess } = await import("../../src/background/process")
    expect(await BackgroundProcess.inspect(grandchild)).toBeUndefined()
  }, 20_000)

  test("a command finishing early is not held open by the watchdog", async () => {
    const job = record()
    const started = Date.now()
    expect(await run("true", job.id, 600_000)).toBe(0)
    expect(Date.now() - started).toBeLessThan(5_000)
  }, 10_000)

  // The log is what the model reads, so the shell's own commentary about the
  // job ("[1]- Done", "Terminated") must not appear in it.
  test("keeps job-control chatter out of the log", async () => {
    const finished = record()
    await run("echo only-this", finished.id, 60_000)
    expect((await BackgroundJob.output(finished.id)).trim()).toBe("only-this")

    const killed = record()
    await run("echo before-kill; sleep 30", killed.id, 1000)
    const output = await BackgroundJob.output(killed.id)
    expect(output).toContain("before-kill")
    expect(output).not.toContain("Terminated")
    expect(output).not.toContain("Done")
  }, 20_000)
})

describe("BackgroundJob paths", () => {
  test("derive from the id alone, so a half-written record cannot lose them", async () => {
    await BackgroundJob.init()
    const id = BackgroundJob.id()
    expect(BackgroundJob.logPath(id)).toBe(`${BackgroundJob.dir}/${id}.log`)
    expect(BackgroundJob.exitPath(id)).toBe(`${BackgroundJob.dir}/${id}.exit`)
    expect((await fs.stat(BackgroundJob.dir)).isDirectory()).toBe(true)
  })
})
