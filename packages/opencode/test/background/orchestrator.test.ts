import { describe, expect, test, afterEach } from "bun:test"
import { BackgroundJob } from "../../src/background/job"
import { BackgroundProcess } from "../../src/background/process"
import { BackgroundOrchestrator } from "../../src/background/orchestrator"

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
describe("BackgroundOrchestrator.sweep at boot", () => {
  test("adopts a job whose session cannot be resolved yet", async () => {
    const proc = spawnJob("sleep 30")
    const job = await store(proc.pid)

    await BackgroundOrchestrator.sweep({ adopting: true })

    expect(await BackgroundJob.get(job.id)).toBeDefined()
    expect(await BackgroundProcess.verify(job.process!)).toBe("alive")
  }, 20_000)

  // The same record, judged on ownership, IS reaped. Without this the first
  // test would pass for the wrong reason (e.g. if nothing swept at all).
  test("reaps that same job once ownership is judged", async () => {
    const proc = spawnJob("sleep 30")
    const job = await store(proc.pid)

    await BackgroundOrchestrator.sweep()

    expect(await BackgroundJob.get(job.id)).toBeUndefined()
    expect(await BackgroundProcess.verify(job.process!)).not.toBe("alive")
  }, 20_000)
})
