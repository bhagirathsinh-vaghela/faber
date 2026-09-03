import { describe, expect, test, afterEach } from "bun:test"
import { BackgroundJob } from "../../src/background/job"
import { BackgroundProcess } from "../../src/background/process"
import { BackgroundSpawn } from "../../src/background/spawn"
import { GlobalBus } from "../../src/bus/global"

const spawned: string[] = []

// Collect every job.updated frame off the GlobalBus for the duration of one
// test. The event rides the same emitter the SSE stream reads, so capturing it
// here is exactly what a connected client would receive.
function collect() {
  const jobs: BackgroundJob.Info[] = []
  const handler = (event: { payload?: { type?: string; properties?: { job?: BackgroundJob.Info } } }) => {
    if (event.payload?.type === BackgroundJob.Event.Updated.type && event.payload.properties?.job)
      jobs.push(event.payload.properties.job)
  }
  GlobalBus.on("event", handler)
  return {
    jobs,
    stop: () => GlobalBus.off("event", handler),
  }
}

async function run(command: string, options: Partial<BackgroundSpawn.Input> = {}) {
  const spawn = await BackgroundSpawn.run({
    command,
    description: "test",
    sessionID: "ses_job_event_test",
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

describe("BackgroundJob.Event", () => {
  // A fast command spawns and settles inside the grace window, so both
  // transitions happen in one call: the view must see the running row AND the
  // finished one, or a quick job flickers into existence with no start.
  test("an inline job publishes a running frame then a settled frame", async () => {
    const seen = collect()
    const spawn = await run("echo hi")
    seen.stop()

    const mine = seen.jobs.filter((job) => job.id === spawn.job.id)
    expect(mine.map((job) => job.status)).toEqual(["running", "exited"])
    expect(mine[1].exit).toBe(0)
  })

  // The settled frame carries the exit code, so a consumer renders "failed
  // (exit 3)" from the event alone without re-reading the record.
  test("the settled frame carries a failing exit code", async () => {
    const seen = collect()
    const spawn = await run("exit 3")
    seen.stop()

    const settled = seen.jobs.filter((job) => job.id === spawn.job.id).at(-1)
    expect(settled?.status).toBe("exited")
    expect(settled?.exit).toBe(3)
  })

  // A backgrounded job publishes its running frame at spawn, before it ends, so
  // the view shows work in flight rather than waiting for the tail.
  test("a backgrounded job publishes a running frame at spawn", async () => {
    const seen = collect()
    const spawn = await run("sleep 30")
    seen.stop()

    expect(spawn.type).toBe("background")
    const mine = seen.jobs.filter((job) => job.id === spawn.job.id)
    expect(mine.length).toBe(1)
    expect(mine[0].status).toBe("running")
  }, 20_000)

  // Stopping a running job settles it `killed` and announces that, so a view
  // learns the job ended the instant the user's stop lands.
  test("stopping a job publishes a killed frame", async () => {
    const spawn = await run("sleep 30")
    expect(spawn.type).toBe("background")

    const seen = collect()
    await BackgroundJob.stop(spawn.job.id)
    seen.stop()

    const killed = seen.jobs.filter((job) => job.id === spawn.job.id).at(-1)
    expect(killed?.status).toBe("killed")
  }, 20_000)
})
