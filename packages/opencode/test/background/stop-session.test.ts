import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { BackgroundJob } from "../../src/background/job"
import { BackgroundSpawn } from "../../src/background/spawn"
import { BackgroundProcess } from "../../src/background/process"
import { Debt } from "../../src/storage/debt"
import { GlobalBus } from "../../src/bus/global"
import { Recovery } from "../../src/session/recovery"
import { SessionPrompt } from "../../src/session/prompt"
import { connected, tmpdir } from "../fixture/fixture"

connected()

// A background job outlives the turn that launched it, and a session accumulates
// them across turns. Stopping the session (the Stop button) is the point at
// which its still-running jobs must end too: nothing else ends a job before its
// hard deadline.
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
        // Deterministically `killed`: stop claims the record out of `running`
        // before it signals the process, so the exit handle the kill triggers
        // finds it already claimed and neither settles it `exited` nor delivers
        // a result. A job that cannot finish on its own during the stop (a 45s
        // sleep under a 600s deadline) therefore always reads `killed`.
        expect((await BackgroundJob.get(spawn.job.id))?.status).toBe("killed")
        // The Stop pays the killed job's debt itself, with a stopped notice.
        expect(await Debt.has(spawn.job.id)).toBe(false)
        const notices = (await Session.messages({ sessionID: session.id })).flatMap((message) =>
          message.parts.flatMap((part) =>
            part.type === "text" && part.backgroundJobResult?.jobId === spawn.job.id
              ? [part.backgroundJobResult.status]
              : [],
          ),
        )
        expect(notices).toEqual(["stopped"])

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
        await Debt.remove(kept.job.id)
        await BackgroundJob.remove(kept.job.id)
      },
    })
  }, 30_000)

  test("a stop that lands while a job is launching abandons the launch", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "stopped mid-launch" })
        // The Stop's cancel reaches the launching turn as its abort reason.
        const abort = new AbortController()
        abort.abort(SessionPrompt.STOPPED)

        const launch = BackgroundSpawn.run({
          command: "echo never",
          description: "launched into a stop",
          sessionID: session.id,
          signal: abort.signal,
          directory: tmp.path,
          project: tmp.path,
          shell: "/bin/sh",
          env: {},
        })

        await expect(launch).rejects.toThrow(`session ${session.id} was stopped while launching job`)
        expect((await BackgroundJob.list()).filter((job) => job.sessionID === session.id)).toEqual([])
        expect(await Debt.owing(session.id)).toBe(false)
      },
    })
  }, 30_000)

  test("a cancelled turn whose marker is already cleared cannot launch", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "marker cleared by the unwind" })
        await Session.mark(session.id, (draft) => void (draft.time.stopped = Date.now() - 500))
        const abort = new AbortController()
        abort.abort()

        const launch = BackgroundSpawn.run({
          command: "echo never",
          description: "launched by a cancelled turn",
          sessionID: session.id,
          signal: abort.signal,
          directory: tmp.path,
          project: tmp.path,
          shell: "/bin/sh",
          env: {},
        })

        await expect(launch).rejects.toThrow(`session ${session.id} was stopped while launching job`)
        expect((await BackgroundJob.list()).filter((job) => job.sessionID === session.id)).toEqual([])
        expect(await Debt.owing(session.id)).toBe(false)
      },
    })
  }, 30_000)

  // Both interrupt a job that finishes inside the grace window, once the launch
  // checks have passed: `act` runs on the running job's announcement, which
  // comes after both. The result must stay owed and be announced to recovery.
  async function interrupted(title: string, act: (session: Session.Info, abort: AbortController) => unknown) {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title })
        await Session.mark(session.id, (draft) => void (draft.turn = { at: Date.now() - 1000, pid: process.pid }))
        const abort = new AbortController()
        const announced: string[] = []
        const previous = BackgroundSpawn.watch((job) => void announced.push(job.id))
        const onEvent = (event: { payload?: { type?: string; properties?: { job?: BackgroundJob.Info } } }) => {
          if (event.payload?.type !== BackgroundJob.Event.Updated.type) return
          if (event.payload.properties?.job?.sessionID !== session.id) return
          if (event.payload.properties.job.status !== "running") return
          void act(session, abort)
        }
        GlobalBus.on("event", onEvent)
        const launched: string[] = []

        try {
          const spawn = await BackgroundSpawn.run({
            command: "sleep 1; echo done",
            description: "outlives the interrupt",
            sessionID: session.id,
            signal: abort.signal,
            directory: tmp.path,
            project: tmp.path,
            shell: "/bin/sh",
            env: {},
          })
          launched.push(spawn.job.id)

          expect(spawn.type).toBe("inline")
          expect(await Debt.owing(session.id)).toBe(true)
          expect(announced).toEqual([spawn.job.id])

          await Recovery.collect(session.id, { wake: false })
          await Recovery.collect(session.id, { wake: false })
          const delivered = (await Session.messages({ sessionID: session.id })).flatMap((message) =>
            message.parts.flatMap((part) =>
              part.type === "text" && part.backgroundJobResult?.jobId === spawn.job.id
                ? [part.backgroundJobResult.status]
                : [],
            ),
          )
          expect(delivered).toEqual(["completed"])
          expect(await Debt.owing(session.id)).toBe(false)
        } finally {
          GlobalBus.off("event", onEvent)
          BackgroundSpawn.watch(previous)
          await Debt.drop(session.id)
          for (const id of launched) await BackgroundJob.remove(id)
        }
      },
    })
  }

  test("a job that finishes inline after an Esc stays owed, so its result is delivered", async () => {
    await interrupted("Esc during the grace window", (_session, abort) => abort.abort())
  }, 30_000)

  // A launch reads only its turn's abort, never the stop stamp: an Esc whose
  // cancel has not landed yet leaves the job to finish inline, and the tool's
  // reply carries its output, so nothing stays owed.
  test("a job finishing between an Esc's stamp and its cancel is answered inline", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Esc stamped, not yet cancelled" })
        await Session.mark(session.id, (draft) => void (draft.time.stopped = Date.now()))

        const spawn = await BackgroundSpawn.run({
          command: "echo done",
          description: "finishes before the cancel",
          sessionID: session.id,
          directory: tmp.path,
          project: tmp.path,
          shell: "/bin/sh",
          env: {},
        })

        expect(spawn.type === "inline" && spawn.output.trim()).toBe("done")
        expect(await Debt.owing(session.id)).toBe(false)
        await BackgroundJob.remove(spawn.job.id)
      },
    })
  }, 30_000)

  test("a turn started after an interrupt launches its jobs", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "prompted after Esc" })
        const now = Date.now()
        await Session.mark(session.id, (draft) => {
          draft.time.stopped = now - 1000
          draft.turn = { at: now - 500, pid: process.pid }
        })

        const spawn = await BackgroundSpawn.run({
          command: "echo launched",
          description: "after an interrupt",
          sessionID: session.id,
          directory: tmp.path,
          project: tmp.path,
          shell: "/bin/sh",
          env: {},
        })

        expect(spawn.type).toBe("inline")
        expect(spawn.type === "inline" && spawn.output.trim()).toBe("launched")
        expect(await Debt.owing(session.id)).toBe(false)
        await BackgroundJob.remove(spawn.job.id)
      },
    })
  }, 30_000)
})
