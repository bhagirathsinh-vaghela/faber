import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { BashTool } from "../../src/tool/bash"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Recovery } from "../../src/session/recovery"
import { SessionPrompt } from "../../src/session/prompt"
import { BackgroundJob } from "../../src/background/job"
import { BackgroundSpawn } from "../../src/background/spawn"
import { BackgroundProcess } from "../../src/background/process"
import { Debt } from "../../src/storage/debt"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const MODEL = "claude-3-5-sonnet-20241022"

function context(sessionID: string, abort = new AbortController().signal) {
  return {
    sessionID,
    messageID: "",
    callID: "",
    agent: "build",
    abort,
    messages: [],
    metadata: () => {},
    ask: async () => {},
  }
}

// No turn runs here (every collect passes `wake: false`, and the kill's own
// collect runs only under a Stop's reason), so the provider is configured but
// never reached.
function project() {
  return tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          enabled_providers: ["anthropic"],
          model: `anthropic/${MODEL}`,
          provider: { anthropic: { options: { apiKey: "test-key", baseURL: "http://127.0.0.1:9/v1" } } },
        }),
      )
    },
  })
}

function launch(sessionID: string, directory: string) {
  return BackgroundSpawn.run({
    command: `sleep ${BackgroundSpawn.GRACE_MS / 1000 + 40}`,
    description: "long job",
    sessionID,
    directory,
    project: directory,
    shell: "/bin/sh",
    env: {},
    hard: 600_000,
  })
}

async function delivered(sessionID: string, jobID: string) {
  return (await Session.messages({ sessionID })).flatMap((message) =>
    message.parts.flatMap((part) =>
      part.type === "text" && part.backgroundJobResult?.jobId === jobID ? [part.backgroundJobResult.status] : [],
    ),
  )
}

describe("tool.bash kill", () => {
  test("killing the session's own running job pays its debt, so nothing is delivered after", async () => {
    await using tmp = await project()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "kills its job" })
        const spawn = await launch(session.id, tmp.path)
        expect(spawn.type).toBe("background")
        expect(await Debt.has(spawn.job.id)).toBe(true)

        const bash = await BashTool.init()
        const reply = await bash.execute({ kill: spawn.job.id, description: "kill it" }, context(session.id))

        expect(reply.output).toBe(`Killed job ${spawn.job.id} and everything it spawned.`)
        const record = await BackgroundJob.get(spawn.job.id)
        expect(record?.status).toBe("killed")
        expect(record?.ended).toBe("kill")
        expect(await Debt.has(spawn.job.id)).toBe(false)

        await Recovery.collect(session.id, { wake: false })
        expect(await delivered(session.id, spawn.job.id)).toEqual([])

        await BackgroundJob.remove(spawn.job.id)
      },
    })
  }, 30_000)

  // A Stop's reason keeps the collect from waking the session, so no turn runs.
  test("a kill from a turn being stopped does not pay in its reply, and collects killed once", async () => {
    await using tmp = await project()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "kills during a Stop" })
        const spawn = await launch(session.id, tmp.path)
        expect(spawn.type).toBe("background")

        const turn = new AbortController()
        turn.abort(SessionPrompt.STOPPED)
        const bash = await BashTool.init()
        const reply = await bash.execute(
          { kill: spawn.job.id, description: "kill it" },
          context(session.id, turn.signal),
        )

        expect(reply.output).toBe(`Killed job ${spawn.job.id} and everything it spawned.`)
        expect((await BackgroundJob.get(spawn.job.id))?.ended).toBe("kill")
        expect(await Debt.has(spawn.job.id)).toBe(false)
        expect(await delivered(session.id, spawn.job.id)).toEqual(["stopped"])

        await Recovery.collect(session.id, { wake: false })
        expect(await delivered(session.id, spawn.job.id)).toEqual(["stopped"])
        const texts = (await Session.messages({ sessionID: session.id })).flatMap((message) =>
          message.parts.flatMap((part) =>
            part.type === "text" && part.backgroundJobResult?.jobId === spawn.job.id ? [part.text] : [],
          ),
        )
        expect(texts.filter((text) => text.includes("killed before it finished")).length).toBe(1)
        expect(await Debt.has(spawn.job.id)).toBe(false)

        await Session.remove(session.id)
        await BackgroundJob.remove(spawn.job.id)
      },
    })
  }, 30_000)

  test("killing another session's job is refused and leaves the job running and owed", async () => {
    await using tmp = await project()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const owner = await Session.create({ title: "owns the job" })
        const intruder = await Session.create({ title: "tries to kill it" })
        const spawn = await launch(owner.id, tmp.path)
        expect(spawn.type).toBe("background")

        const bash = await BashTool.init()
        await expect(
          bash.execute({ kill: spawn.job.id, description: "kill it" }, context(intruder.id)),
        ).rejects.toThrow(
          `Refusing to kill job ${spawn.job.id}: it belongs to session ${owner.id}, not this session (${intruder.id}).`,
        )

        expect((await BackgroundJob.get(spawn.job.id))?.status).toBe("running")
        expect(await Debt.has(spawn.job.id)).toBe(true)

        await BackgroundJob.stop(spawn.job.id)
        await Debt.remove(spawn.job.id)
        await BackgroundJob.remove(spawn.job.id)
      },
    })
  }, 30_000)

  test("killing a job that already finished delivers its output at once, and only once", async () => {
    await using tmp = await project()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "job finished first" })
        const id = BackgroundJob.id()
        await BackgroundJob.write({
          id,
          sessionID: session.id,
          directory: Instance.directory,
          project: Instance.directory,
          command: "echo hi",
          description: "say hi",
          status: "exited",
          exit: 0,
          time: { created: Date.now() - 1000, hard: Date.now() + 60_000, completed: Date.now() },
        })
        await Debt.add(id, "job", session.id)

        const bash = await BashTool.init()
        const reply = await bash.execute({ kill: id, description: "kill it" }, context(session.id))

        expect(reply.output).toBe(`Job ${id} had already ended (completed, exit 0); its result was already delivered.`)
        expect(await Debt.has(id)).toBe(false)

        await Recovery.collect(session.id, { wake: false })
        expect(await delivered(session.id, id)).toEqual(["completed"])
        expect(await Debt.has(id)).toBe(false)

        await BackgroundJob.remove(id)
      },
    })
  }, 30_000)

  test("killing a job whose result was already delivered says so, promising nothing", async () => {
    await using tmp = await project()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "result already delivered" })
        const id = BackgroundJob.id()
        await BackgroundJob.write({
          id,
          sessionID: session.id,
          directory: Instance.directory,
          project: Instance.directory,
          command: "echo hi",
          description: "say hi",
          status: "exited",
          exit: 0,
          time: { created: Date.now() - 1000, hard: Date.now() + 60_000, completed: Date.now() },
        })

        const bash = await BashTool.init()
        const reply = await bash.execute({ kill: id, description: "kill it" }, context(session.id))

        expect(reply.output).toBe(`Job ${id} had already ended (completed, exit 0); its result was already delivered.`)

        await BackgroundJob.remove(id)
      },
    })
  }, 30_000)

  // The record still reads running, but its pid is gone: the job is settled as
  // it really ended, never reported as killed, and its result delivered now.
  test("killing a job whose process already exited reports its real exit and delivers it at once", async () => {
    await using tmp = await project()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "process already gone" })
        const proc = Bun.spawn({ cmd: ["sh", "-c", "sleep 30"], detached: true, stdio: ["ignore", "ignore", "ignore"] })
        const live = (await BackgroundProcess.inspect(proc.pid))!
        process.kill(-proc.pid, "SIGKILL")
        await proc.exited
        const id = BackgroundJob.id()
        await BackgroundJob.init()
        await BackgroundJob.create({
          id,
          sessionID: session.id,
          directory: Instance.directory,
          project: Instance.directory,
          command: "exit 3",
          description: "fails",
          status: "running",
          process: { pid: live.pid, start: live.start, pgid: live.pgid },
          time: { created: Date.now() - 1000, hard: Date.now() + 60_000 },
        })
        await Bun.write(BackgroundJob.exitPath(id), "3\n")

        const bash = await BashTool.init()
        const reply = await bash.execute({ kill: id, description: "kill it" }, context(session.id))

        expect(reply.output).toBe(`Job ${id} had already ended (failed, exit 3); its result was already delivered.`)
        expect((await BackgroundJob.get(id))?.status).toBe("exited")
        expect(await Debt.has(id)).toBe(false)
        expect(await delivered(session.id, id)).toEqual(["failed"])

        await Session.remove(session.id)
        await BackgroundJob.remove(id)
      },
    })
  }, 30_000)

  // The wrapper writes its exit file and only then exits, so a job can have
  // ended on its own while its pid still verifies. A kill landing then is
  // recorded as the job's own exit, never as a kill.
  test("killing a job that wrote its exit before the kill's claim records its own exit", async () => {
    await using tmp = await project()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "exited before the claim" })
        const proc = Bun.spawn({ cmd: ["sh", "-c", "sleep 30"], detached: true, stdio: ["ignore", "ignore", "ignore"] })
        const live = (await BackgroundProcess.inspect(proc.pid))!
        const id = BackgroundJob.id()
        await BackgroundJob.init()
        await BackgroundJob.create({
          id,
          sessionID: session.id,
          directory: Instance.directory,
          project: Instance.directory,
          command: "exit 3",
          description: "fails",
          status: "running",
          process: { pid: live.pid, start: live.start, pgid: live.pgid },
          time: { created: Date.now() - 10_000, hard: Date.now() + 60_000 },
        })
        await Bun.write(BackgroundJob.exitPath(id), "3\n")
        const past = new Date(Date.now() - 5_000)
        await fs.utimes(BackgroundJob.exitPath(id), past, past)

        const bash = await BashTool.init()
        const reply = await bash.execute({ kill: id, description: "kill it" }, context(session.id))
        await proc.exited

        const record = await BackgroundJob.get(id)
        expect(reply.output).toBe(`Job ${id} had already ended (failed, exit 3); its result was already delivered.`)
        expect(record?.status).toBe("exited")
        expect(record?.ended).toBeUndefined()
        expect(record?.exit).toBe(3)
        expect(await Debt.has(id)).toBe(false)
        expect(await delivered(session.id, id)).toEqual(["failed"])

        await Session.remove(session.id)
        await BackgroundJob.remove(id)
      },
    })
  }, 30_000)

  // An exit file within GRACE_MS of the claim is the kill's own doing: the
  // filesystem clock can trail Date.now(), so a file a few ms "before" the
  // claim was still written by the TERM the kill just sent.
  test("an exit file within the clock grace of the claim reads as a kill, not its own exit", async () => {
    await using tmp = await project()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "killed within the grace" })
        const proc = Bun.spawn({ cmd: ["sh", "-c", "sleep 30"], detached: true, stdio: ["ignore", "ignore", "ignore"] })
        const live = (await BackgroundProcess.inspect(proc.pid))!
        const id = BackgroundJob.id()
        await BackgroundJob.init()
        await BackgroundJob.create({
          id,
          sessionID: session.id,
          directory: Instance.directory,
          project: Instance.directory,
          command: "sleep 30",
          description: "runs",
          status: "running",
          process: { pid: live.pid, start: live.start, pgid: live.pgid },
          time: { created: Date.now() - 10_000, hard: Date.now() + 60_000 },
        })
        await Bun.write(BackgroundJob.exitPath(id), "143\n")
        // 10ms before now is inside the 50ms grace: the kill's own doing.
        const justBefore = new Date(Date.now() - 10)
        await fs.utimes(BackgroundJob.exitPath(id), justBefore, justBefore)

        const bash = await BashTool.init()
        const reply = await bash.execute({ kill: id, description: "kill it" }, context(session.id))
        await proc.exited

        const record = await BackgroundJob.get(id)
        expect(reply.output).toBe(`Killed job ${id} and everything it spawned.`)
        expect(record?.status).toBe("killed")
        expect(record?.ended).toBe("kill")

        await Session.remove(session.id)
        await BackgroundJob.remove(id)
      },
    })
  }, 30_000)
})
