import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import path from "path"
import { Recovery } from "../../src/session/recovery"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionBusy } from "../../src/session/busy"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Meta } from "../../src/storage/meta"
import { Owed } from "../../src/storage/owed"
import { Sessions } from "../../src/storage/sessions"
import { Messages } from "../../src/storage/messages"
import { BackgroundJob } from "../../src/background/job"
import { BackgroundProcess } from "../../src/background/process"
import { BackgroundReconcile } from "../../src/background/reconcile"
import { AgentTool } from "../../src/tool/agent"
import { Agent } from "../../src/agent/agent"
import type { Tool } from "../../src/tool/tool"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

// Paths the main recovery suite leaves alone: paying without the lease, a
// turn its instance disposed, a job another process launched, the agent
// tool's launch guards. Recovery stays closed here except where a test opens
// it, so nothing but the behaviour under test acts on the shared database.

const MODEL = "claude-3-5-sonnet-20241022"
const model = { providerID: "anthropic", modelID: MODEL }
const LIVE = process.ppid

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  replies: [] as string[],
  hold: undefined as Promise<void> | undefined,
}

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      await req.json()
      if (state.hold) await state.hold
      return reply(state.replies.shift() ?? "fallback")
    },
  })
})

const made: string[] = []

afterEach(async () => {
  Recovery.stop()
  state.replies.length = 0
  state.hold = undefined
  for (const id of made.splice(0))
    await Sessions.update(id, (draft) => {
      draft.time.stopped = Date.now() + 60_000
      draft.turn = undefined
    }).catch(() => {})
})

afterAll(() => state.server?.stop())

function reply(value: string) {
  const chunks = [
    {
      type: "message_start",
      message: {
        id: "msg-1",
        model: MODEL,
        usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: value } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ]
  const payload = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n") + "\n\n"
  return new Response(payload, { status: 200, headers: { "Content-Type": "text/event-stream" } })
}

async function until(check: () => Promise<boolean> | boolean, what: string, ms = 10_000) {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(10)
  }
}

async function project() {
  return tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          enabled_providers: ["anthropic"],
          model: `anthropic/${MODEL}`,
          provider: { anthropic: { options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` } } },
        }),
      )
    },
  })
}

async function user(sessionID: string, text: string) {
  const info = await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model,
  })
  await Session.updatePart({ id: Identifier.ascending("part"), messageID: info.id, sessionID, type: "text", text })
  return info
}

async function assistant(sessionID: string, parentID: string, text: string) {
  const info = await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "assistant",
    parentID,
    mode: "build",
    agent: "build",
    path: { cwd: Instance.directory, root: Instance.worktree },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: MODEL,
    providerID: "anthropic",
    time: { created: Date.now(), completed: Date.now() },
    finish: "stop",
  })
  await Session.updatePart({ id: Identifier.ascending("part"), messageID: info.id, sessionID, type: "text", text })
  return info
}

async function root() {
  const created = await Session.create({})
  made.push(created.id)
  return created
}

async function child(parentID: string) {
  const created = await Session.create({ parentID, title: "count files (@general subagent)" })
  made.push(created.id)
  return Session.update(created.id, (draft) => {
    draft.time.injected = 0
    draft.current = { agent: "build", model }
  })
}

// The wake a delivery starts is fire-and-forget, so waiting on "not busy"
// can pass before it begins. Wait for a finished reply after the delivered
// message, then for the session to be idle. Keyed on order, not on reply
// text: a title request can take any queued reply first.
async function answered(sessionID: string) {
  await until(async () => {
    const messages = await Session.messages({ sessionID })
    const delivered = messages.findLastIndex((m) => m.info.role === "user" && m.info.synthetic)
    const reply = messages.findLast((m) => m.info.role === "assistant")
    return (
      delivered >= 0 &&
      !!reply &&
      messages.indexOf(reply) > delivered &&
      reply.info.role === "assistant" &&
      reply.info.time.completed !== undefined &&
      !SessionBusy.busy(sessionID)
    )
  }, `a finished turn answering the delivery in ${sessionID}`)
}

async function results(sessionID: string) {
  return (await Session.messages({ sessionID })).flatMap((m) =>
    m.parts.flatMap((p) =>
      p.type === "text" && p.backgroundSubagentResult ? [p.backgroundSubagentResult.status] : [],
    ),
  )
}

describe("Recovery.collect", () => {
  test("pays a finished child's result with no lease held by this process", async () => {
    await using tmp = await project()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const before = await Meta.get("recovery.lease")
        await Meta.update("recovery.lease", () => JSON.stringify({ pid: LIVE, at: Date.now(), primary: true }))
        try {
          const parent = await root()
          const sub = await child(parent.id)
          const prompt = await user(sub.id, "count")
          await assistant(sub.id, prompt.id, "7")

          // Opened so the lease is really evaluated: a live primary holds it.
          Recovery.start()
          expect(await Recovery.lease()).toBe(false)
          await Recovery.collect(sub.id)

          expect(await results(parent.id)).toEqual(["completed"])
          await answered(parent.id)
        } finally {
          await Meta.update("recovery.lease", () => before ?? JSON.stringify({ pid: 1, at: 0 }))
        }
      },
    })
  }, 30_000)

  test("pays a job's result while the session still marks a turn", async () => {
    await using tmp = await project()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await root()
        await user(session.id, "run it")
        await Session.mark(
          session.id,
          (draft) => void (draft.turn = { at: Date.now(), pid: process.pid, boot: Recovery.boot }),
        )
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
        await Owed.add(id, session.id)
        try {
          await Recovery.collect(session.id)

          expect(await Owed.pending(session.id)).toBe(false)
          await answered(session.id)
        } finally {
          await Owed.remove(id)
          await BackgroundJob.remove(id)
        }
      },
    })
  }, 30_000)

  test("a turn that ends pays its session's settled job without being asked", async () => {
    await using tmp = await project()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await root()
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
        await Owed.add(id, session.id)
        try {
          Recovery.start()
          await SessionPrompt.prompt({ sessionID: session.id, parts: [{ type: "text", text: "go" }] })

          // Paid after the turn fully ends, so the wake it starts is a turn of
          // its own that answers the result; run while the first turn was
          // still in flight, the wake would join it and nothing would answer.
          await until(async () => !(await Owed.pending(session.id)), "the debt to be paid")
          await answered(session.id)
        } finally {
          await Owed.remove(id)
          await BackgroundJob.remove(id)
        }
      },
    })
  }, 30_000)
})

describe("an instance dispose", () => {
  test("leaves the turn's marker dead, and pays nothing for the directory going away", async () => {
    await using tmp = await project()
    const release = Promise.withResolvers<void>()
    state.hold = release.promise
    const job = BackgroundJob.id()
    const id = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await root()
        await BackgroundJob.write({
          id: job,
          sessionID: session.id,
          directory: Instance.directory,
          project: Instance.directory,
          command: "echo hi",
          description: "say hi",
          status: "exited",
          exit: 0,
          time: { created: Date.now() - 1000, hard: Date.now() + 60_000, completed: Date.now() },
        })
        await Owed.add(job, session.id)
        void SessionPrompt.prompt({ sessionID: session.id, parts: [{ type: "text", text: "go" }] }).catch(() => {})
        await until(() => SessionBusy.busy(session.id), "the turn to start")
        await until(async () => !!(await Sessions.read(session.id)).turn, "the turn marker")
        await Instance.dispose()
        return session.id
      },
    })
    try {
      release.resolve()
      state.hold = undefined

      await until(() => !SessionBusy.busy(id), "the disposed turn to unwind")
      const turn = (await Sessions.read(id)).turn
      expect(turn?.pid).toBe(process.pid)
      expect(turn?.boot).toBe(0)
      expect(await Recovery.cut((await Sessions.read(id)) as Session.Info)).toBe(true)
      // The turn's exit skipped collecting: the debt is the next server's.
      // Collect is fired without being awaited, so the debt must STAY
      // pending across a window a started collect would have finished in.
      const watched = Date.now()
      while (Date.now() - watched < 500) {
        expect(await Owed.pending(id)).toBe(true)
        await Bun.sleep(25)
      }
      // A turn that ends normally collects by the same path, so one run to
      // its end is the event that proves that path does pay.
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Session.mark(id, (draft) => void (draft.turn = undefined))
          await SessionPrompt.prompt({ sessionID: id, parts: [{ type: "text", text: "again" }] })
          await until(async () => !(await Owed.pending(id)), "the normal turn's end to pay the debt")
        },
      })
    } finally {
      await Owed.remove(job)
      await BackgroundJob.remove(job)
    }
  }, 30_000)
})

describe("a job another process launched", () => {
  test("is left to its live launcher by this process's pass", async () => {
    // Named by a live process this test owns and its real start time, read
    // the way `alive` reads it, so the launcher reads alive.
    const other = Bun.spawn(["sleep", "30"])
    const out = await new Response(
      Bun.spawn(["ps", "-o", "lstart=", "-p", String(other.pid)], {
        stdout: "pipe",
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      }).stdout,
    ).text()
    const started = Math.floor(new Date(out.trim() + " UTC").getTime() / 1000)
    const pid = other.pid
    const id = BackgroundJob.id()
    await BackgroundJob.write({
      id,
      sessionID: "ses_launcher_test",
      directory: "/tmp",
      command: "true",
      description: "held elsewhere",
      status: "running",
      launcher: { pid, boot: started },
      time: { created: Date.now(), hard: Date.now() + 60_000 },
    })
    try {
      expect(await BackgroundProcess.alive({ pid, boot: started })).toBe(true)

      const pass = await BackgroundReconcile.run({ alive: () => true })

      expect(pass.actions.find((action) => action.job.id === id)?.type).toBe("kept")
      expect((await BackgroundJob.get(id))?.status).toBe("running")
    } finally {
      other.kill()
      await BackgroundJob.remove(id)
    }
  }, 30_000)

  test("is reaped once its launcher is gone and it never got an identity", async () => {
    const id = BackgroundJob.id()
    await BackgroundJob.write({
      id,
      sessionID: "ses_launcher_test",
      directory: "/tmp",
      command: "true",
      description: "launcher died",
      status: "running",
      launcher: { pid: 2 ** 22 + 12345, boot: 1 },
      time: { created: Date.now(), hard: Date.now() + 60_000 },
    })
    await Owed.add(id, "ses_launcher_test")
    try {
      const pass = await BackgroundReconcile.run({ alive: () => true })

      expect(pass.actions.find((action) => action.job.id === id)?.type).toBe("reaped")
      expect(await BackgroundJob.get(id)).toBeUndefined()
      expect(await Owed.pending("ses_launcher_test")).toBe(false)
    } finally {
      await BackgroundJob.remove(id).catch(() => {})
      await Owed.remove(id)
    }
  }, 30_000)

  test("is reaped when it names this process but this process no longer holds it", async () => {
    const id = BackgroundJob.id()
    await BackgroundJob.write({
      id,
      sessionID: "ses_launcher_self",
      directory: "/tmp",
      command: "true",
      description: "let go by this process",
      status: "running",
      launcher: { pid: process.pid, boot: BackgroundProcess.boot },
      time: { created: Date.now(), hard: Date.now() + 60_000 },
    })
    await Owed.add(id, "ses_launcher_self")
    try {
      const pass = await BackgroundReconcile.run({ alive: () => true })

      expect(pass.actions.find((action) => action.job.id === id)?.type).toBe("reaped")
      expect(await BackgroundJob.get(id)).toBeUndefined()
      expect(await Owed.pending("ses_launcher_self")).toBe(false)
    } finally {
      await BackgroundJob.remove(id).catch(() => {})
      await Owed.remove(id)
    }
  }, 30_000)
})

describe("the agent tool", () => {
  async function tool(sessionID: string, messageID: string, abort = new AbortController().signal) {
    const info = await AgentTool.init()
    const toolset = Object.keys(await Agent.toolsets())[0]
    const ctx: Tool.Context = {
      sessionID,
      messageID,
      agent: "build",
      abort,
      callID: "call_1",
      extra: { bypassAgentCheck: true },
      messages: [],
      metadata: () => {},
      ask: async () => {},
    }
    return (params: Partial<Parameters<typeof info.execute>[0]>) =>
      info.execute({ description: "count files", prompt: "count", subagent_type: "general", toolset, ...params }, ctx)
  }

  // A signal that reads live on the first `live` checks and aborted on every
  // later one, so the stop lands between the launch's checks.
  function late(live = 1) {
    const reads = { count: 0 }
    return {
      get aborted() {
        return reads.count++ >= live
      },
    } as AbortSignal
  }

  test("refuses a session_id that is not this session's subagent", async () => {
    await using tmp = await project()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await root()
        const other = await root()
        const stranger = await child(other.id)
        const prompt = await user(parent.id, "go")
        const reply = await assistant(parent.id, prompt.id, "")

        const run = await tool(parent.id, reply.id)
        const unknown = await run({ session_id: "ses_does_not_exist" })
        const foreign = await run({ session_id: stranger.id })

        expect(unknown.output).toBe(
          "Session ses_does_not_exist does not exist. Omit session_id to start a new subagent.",
        )
        expect(foreign.output).toBe(
          `Session ${stranger.id} is not a subagent of this session, so it cannot be continued here. Omit session_id to start a new subagent.`,
        )
        expect(await Session.children(parent.id)).toEqual([])
      },
    })
  }, 30_000)

  test("launches nothing from a turn a stop has cancelled", async () => {
    await using tmp = await project()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await root()
        const prompt = await user(parent.id, "go")
        const reply = await assistant(parent.id, prompt.id, "")

        const run = await tool(parent.id, reply.id, late())

        await expect(run({})).rejects.toThrow(`session ${parent.id} was stopped before its subagent launched`)
        const children = await Session.children(parent.id)
        made.push(...children.map((c) => c.id))
        expect(children.length).toBe(1)
        expect(children[0].time.stopped).toBeNumber()
      },
    })
  }, 30_000)

  test("a continued child stopped while it runs shows stopped, not its earlier report", async () => {
    await using tmp = await project()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await root()
        const sub = await child(parent.id)
        const first = await user(sub.id, "count")
        await assistant(sub.id, first.id, "7")
        await Session.update(sub.id, (draft) => {
          draft.time.injected = Date.now()
          draft.time.reported = "completed"
        })
        const prompt = await user(parent.id, "go")
        const reply = await assistant(parent.id, prompt.id, "")
        const release = Promise.withResolvers<void>()
        state.hold = release.promise
        await Bun.sleep(5)

        await (await tool(parent.id, reply.id))({ session_id: sub.id })

        expect((await Messages.reader()).prompted(sub.id)).toBeGreaterThan(first.time.created)
        await until(() => SessionBusy.busy(sub.id), `${sub.id} to run`)
        await Session.stop({ sessionID: parent.id })
        release.resolve()
        await until(() => !SessionBusy.busy(sub.id), `${sub.id} to go idle`)
        expect((await Recovery.subagents(parent.id)).map((s) => s.status)).toEqual(["stopped"])
        expect(await results(parent.id)).toEqual([])
      },
    })
  }, 30_000)

  test("a stop that lands while the child's prompt is written launches nothing", async () => {
    await using tmp = await project()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await root()
        const prompt = await user(parent.id, "go")
        const reply = await assistant(parent.id, prompt.id, "")

        const run = await tool(parent.id, reply.id, late(2))

        await expect(run({})).rejects.toThrow(`session ${parent.id} was stopped before its subagent launched`)
        const [sub] = await Session.children(parent.id)
        made.push(sub.id)
        const read = await Messages.reader()
        expect(read.prompted(sub.id)).toBeGreaterThan(0)
        expect(sub.time.stopped).toBeGreaterThanOrEqual(read.prompted(sub.id))
        expect(SessionBusy.busy(sub.id)).toBe(false)
        expect((await Recovery.subagents(parent.id)).map((s) => s.status)).toEqual(["stopped"])
      },
    })
  }, 30_000)

  test("a launch that fails before its prompt stops the child it made", async () => {
    await using tmp = await project()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await root()
        const prompt = await user(parent.id, "go")

        const run = await tool(parent.id, prompt.id)

        await expect(run({})).rejects.toThrow(`message ${prompt.id} calling the agent tool is not an assistant message`)
        const children = await Session.children(parent.id)
        made.push(...children.map((c) => c.id))
        expect(children.length).toBe(1)
        expect(children[0].time.stopped).toBeNumber()
      },
    })
  }, 30_000)
})
