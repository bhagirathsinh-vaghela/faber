import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { BackgroundJob } from "../../src/background/job"
import { BackgroundSpawn } from "../../src/background/spawn"
import { BackgroundProcess } from "../../src/background/process"
import { tmpdir } from "../fixture/fixture"

// A background job outlives the turn that launched it, and a session accumulates
// them across turns. Stopping the session (the Stop button) is the point at
// which its still-running jobs must end too: nothing else reaps a stopped
// session's jobs before their hard deadline, because the reconcile owner-gone
// path never fires in production (its liveness predicate answers only
// `true`/`undefined`, never `false`).
describe("Session.stop reaps the session's background jobs", () => {
  test("stopping a session kills a job it launched", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "owns a job" })
        const spawn = await BackgroundSpawn.run({
          command: `echo "CMDPID=$$"; sleep ${BackgroundSpawn.GRACE_MS / 1000 + 40}`,
          description: "long job",
          sessionID: session.id,
          directory: tmp.path,
          project: tmp.path,
          shell: "/bin/sh",
          env: {},
          hard: 600_000,
        })
        expect(spawn.type).toBe("background")

        await Bun.sleep(600)
        const cmdpid = Number(/CMDPID=(\d+)/.exec((await BackgroundJob.output(spawn.job.id)) ?? "")?.[1])
        expect(cmdpid).toBeGreaterThan(0)

        await Session.stop({ sessionID: session.id })
        // Past the wrapper's escalation window plus the outer killer's margin.
        await Bun.sleep((BackgroundProcess.ESCALATION_SECONDS + 2) * 1000)

        const alive = await Bun.$`ps -p ${cmdpid} -o pid=`.quiet().nothrow()
        expect(alive.stdout.toString().trim()).toBe("")
        // Settled, not left running for a sweep that never comes. Whether the
        // record reads `killed` (stop's own write won) or `exited` (the wrapper
        // wrote its exit file as it died and the exit watcher settled first) is
        // a race between two settle paths; both mean the job is over and no
        // result is coming. The invariant is that it is NOT still running.
        expect((await BackgroundJob.get(spawn.job.id))?.status).not.toBe("running")

        await BackgroundJob.remove(spawn.job.id)
      },
    })
  }, 30_000)

  test("stopping a session leaves another session's job running", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const stopped = await Session.create({ title: "to stop" })
        const other = await Session.create({ title: "to keep" })

        const kept = await BackgroundSpawn.run({
          command: `sleep ${BackgroundSpawn.GRACE_MS / 1000 + 40}`,
          description: "other session's job",
          sessionID: other.id,
          directory: tmp.path,
          project: tmp.path,
          shell: "/bin/sh",
          env: {},
          hard: 600_000,
        })
        expect(kept.type).toBe("background")

        await Session.stop({ sessionID: stopped.id })
        await Bun.sleep((BackgroundProcess.ESCALATION_SECONDS + 2) * 1000)

        // The untouched session's job is still running.
        const record = await BackgroundJob.get(kept.job.id)
        expect(record?.status).toBe("running")
        expect(await BackgroundProcess.verify(record!.process!)).toBe("alive")

        await BackgroundJob.stop(kept.job.id)
        await BackgroundJob.remove(kept.job.id)
      },
    })
  }, 30_000)
})
