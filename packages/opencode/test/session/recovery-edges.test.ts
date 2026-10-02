import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import path from "path"
import { Recovery } from "../../src/session/recovery"
import { Bus } from "../../src/bus"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionBusy } from "../../src/session/busy"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Meta } from "../../src/storage/meta"
import { Debt } from "../../src/storage/debt"
import { Sessions } from "../../src/storage/sessions"
import { BackgroundJob } from "../../src/background/job"
import { BackgroundProcess } from "../../src/background/process"
import { BackgroundReconcile } from "../../src/background/reconcile"
import { AgentTool } from "../../src/tool/agent"
import { SessionPing } from "../../src/session/ping"
import { Agent } from "../../src/agent/agent"
import type { Tool } from "../../src/tool/tool"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { Provider } from "../../src/provider/provider"

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
  for (const id of made.splice(0)) {
    await Sessions.update(id, (draft) => {
      draft.time.stopped = Date.now() + 60_000
      draft.turn = undefined
    }).catch(() => {})
    await Debt.drop(id)
  }
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
  await Debt.add(created.id, "subagent", parentID)
  return Session.update(created.id, (draft) => void (draft.current = { agent: "build", model }))
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

describe("Recovery re-arming", () => {
  test("any pass re-arms a warm keep-warm session no daemon keeps, and leaves a cold one", async () => {
    await using tmp = await tmpdir({ git: true, config: { ping: { enabled: true } } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const warm = await root()
        const cold = await root()
        await Sessions.update(warm.id, (draft) => {
          draft.keepWarm = true
          draft.cache = { lastRequestAt: Date.now() - 60_000 }
        })
        await Sessions.update(cold.id, (draft) => {
          draft.keepWarm = true
          draft.cache = { lastRequestAt: Date.now() - 10 * 60_000 }
        })
        Recovery.start()
        try {
          // Two passes: the first one after boot is not special.
          await Recovery.poke()
          await Recovery.poke()
          await until(() => SessionPing.running(warm.id), "the warm session to be re-armed")
          expect(SessionPing.running(cold.id)).toBe(false)
        } finally {
          await SessionPing.stop(warm.id)
        }
      },
    })
  }, 30_000)
})

describe("Recovery.collect", () => {
  test("pays a finished child's result with no lease held by this process", async () => {
    await using tmp = await project()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const before = await Meta.get("recovery.lease")
        await Meta.update("recovery.lease", () => JSON.stringify({ pid: LIVE, at: Date.now() }))
        try {
          const parent = await root()
          const sub = await child(parent.id)
          const prompt = await user(sub.id, "count")
          await assistant(sub.id, prompt.id, "7")

          // Opened so the lease is really evaluated: a live holder has it.
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
        await Debt.add(id, "job", session.id)
        try {
          await Recovery.collect(session.id)

          expect(await Debt.owing(session.id)).toBe(false)
          await answered(session.id)
        } finally {
          await Debt.remove(id)
          await BackgroundJob.remove(id)
        }
      },
    })
  }, 30_000)

  test("a Stop on a responder pays its cancelled notice at once while an attempt is in flight", async () => {
    // The caller lives in a directory whose instance bootstrap waits on a
    // plugin, so an attempt that has already judged the child is held there.
    const hold = globalThis as { recoveryEntered?: () => void; recoveryHold?: Promise<void> }
    await using caller = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "hold.ts"),
          `export default async () => {
            const hold = globalThis
            hold.recoveryEntered?.()
            await hold.recoveryHold
            return {}
          }`,
        )
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: ["anthropic"],
            model: `anthropic/${MODEL}`,
            plugin: [`file://${path.join(dir, "hold.ts")}`],
            provider: { anthropic: { options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` } } },
          }),
        )
      },
    })
    const parent = await Instance.provide({
      directory: caller.path,
      fn: async () => {
        const created = await root()
        await Instance.dispose()
        return created
      },
    })
    await using workspace = await project()
    await Instance.provide({
      directory: workspace.path,
      fn: async () => {
        const sub = await child(parent.id)
        await Session.mark(
          sub.id,
          (draft) => void (draft.turn = { at: Date.now(), pid: process.pid, boot: Recovery.boot }),
        )
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        hold.recoveryEntered = entered.resolve
        hold.recoveryHold = release.promise
        state.replies.push("noted", "noted")
        try {
          // Judges the child mid-turn, then waits in the caller's bootstrap.
          const inflight = Recovery.collect(sub.id)
          await entered.promise
          await Sessions.update(sub.id, (draft) => void (draft.time.stopped = Date.now()))
          const cancelling = Recovery.stopped(sub.id, { wake: true })
          // Every microtask drains before the next macrotask, so the cancel has
          // reached the attempt in flight before it is let go.
          await new Promise((resolve) => setImmediate(resolve))
          release.resolve()
          await inflight
          await cancelling

          expect(await results(parent.id)).toEqual(["cancelled"])
          expect(await Debt.has(sub.id)).toBe(false)
          await Instance.provide({ directory: caller.path, fn: () => answered(parent.id) })
        } finally {
          release.resolve()
          hold.recoveryEntered = undefined
          hold.recoveryHold = undefined
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
        await Debt.add(id, "job", session.id)
        try {
          Recovery.start()
          await SessionPrompt.prompt({
            model: Provider.DEFAULT,
            variant: Provider.DEFAULT,
            sessionID: session.id,
            parts: [{ type: "text", text: "go" }],
          })

          // Paid after the turn fully ends, so the wake it starts is a turn of
          // its own that answers the result; run while the first turn was
          // still in flight, the wake would join it and nothing would answer.
          await until(async () => !(await Debt.owing(session.id)), "the debt to be paid")
          await answered(session.id)
        } finally {
          await Debt.remove(id)
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
        await Debt.add(job, "job", session.id)
        void SessionPrompt.prompt({
          model: Provider.DEFAULT,
          variant: Provider.DEFAULT,
          sessionID: session.id,
          parts: [{ type: "text", text: "go" }],
        }).catch(() => {})
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
        expect(await Debt.owing(id)).toBe(true)
        await Bun.sleep(25)
      }
      // A turn that ends normally collects by the same path, so one run to
      // its end is the event that proves that path does pay.
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Session.mark(id, (draft) => void (draft.turn = undefined))
          await SessionPrompt.prompt({
            model: Provider.INHERIT,
            variant: Provider.INHERIT,
            sessionID: id,
            parts: [{ type: "text", text: "again" }],
          })
          await until(async () => !(await Debt.owing(id)), "the normal turn's end to pay the debt")
        },
      })
    } finally {
      await Debt.remove(job)
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

      const pass = await BackgroundReconcile.run()

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
    await Debt.add(id, "job", "ses_launcher_test")
    try {
      const pass = await BackgroundReconcile.run()

      expect(pass.actions.find((action) => action.job.id === id)?.type).toBe("reaped")
      expect(await BackgroundJob.get(id)).toBeUndefined()
      expect(await Debt.owing("ses_launcher_test")).toBe(false)
    } finally {
      await BackgroundJob.remove(id).catch(() => {})
      await Debt.remove(id)
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
    await Debt.add(id, "job", "ses_launcher_self")
    try {
      const pass = await BackgroundReconcile.run()

      expect(pass.actions.find((action) => action.job.id === id)?.type).toBe("reaped")
      expect(await BackgroundJob.get(id)).toBeUndefined()
      expect(await Debt.owing("ses_launcher_self")).toBe(false)
    } finally {
      await BackgroundJob.remove(id).catch(() => {})
      await Debt.remove(id)
    }
  }, 30_000)
})

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

describe("the agent tool", () => {
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
        expect(await Session.children(parent.id)).toEqual([])
        expect(await Debt.owing(parent.id)).toBe(false)
      },
    })
  }, 30_000)

  test("a launch records its debt in the same write as the child's prompt", async () => {
    await using tmp = await project()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await root()
        const prompt = await user(parent.id, "go")
        const reply = await assistant(parent.id, prompt.id, "")
        const release = Promise.withResolvers<void>()
        state.hold = release.promise

        const launched = await (await tool(parent.id, reply.id))({})
        const id = launched.metadata.sessionId as string
        made.push(id)
        const debt = await Debt.get(id)
        const [launch] = await Session.messages({ sessionID: id })

        expect(debt).toEqual({
          responder: id,
          kind: "subagent",
          caller: parent.id,
          created: launch.info.time.created,
          asks: 0,
        })
        const toolset = Object.keys(await Agent.toolsets())[0]
        expect(launched.metadata).toMatchObject({
          status: "async_launched",
          mode: "launched",
          description: "count files",
          subagentType: "general",
          includeContext: false,
          toolset,
          tools: (await Agent.toolsets())[toolset],
          sessionId: id,
        })
        release.resolve()
        await until(async () => !(await Debt.has(id)), "the child to report")
        expect(await results(parent.id)).toEqual(["completed"])
      },
    })
  }, 30_000)

  test("a prompt into a child still owing joins its debt, and it reports once", async () => {
    await using tmp = await project()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await root()
        const sub = await child(parent.id)
        const first = await user(sub.id, "count")
        const release = Promise.withResolvers<void>()
        state.hold = release.promise
        void SessionPrompt.wake(sub.id).catch(() => {})
        await until(() => SessionBusy.busy(sub.id), `${sub.id} to run`)
        const prompt = await user(parent.id, "go")
        const reply = await assistant(parent.id, prompt.id, "")

        const steered = await (await tool(parent.id, reply.id))({ session_id: sub.id, summary: "recount" })

        expect(steered.metadata).toMatchObject({ mode: "steered", sessionId: sub.id, summary: "recount" })
        expect(steered.output.split("\n")[0]).toBe(
          "Prompt delivered to the running subagent: count files. It reports once, covering both asks.",
        )
        expect((await Debt.list()).filter((debt) => debt.responder === sub.id).length).toBe(1)
        expect((await Session.children(parent.id)).map((c) => c.id)).toEqual([sub.id])
        state.hold = undefined
        release.resolve()
        await until(async () => !(await Debt.has(sub.id)), "the child to report")
        await until(() => !SessionBusy.busy(sub.id), `${sub.id} to go idle`)
        expect(await results(parent.id)).toEqual(["completed"])
        expect((await Session.messages({ sessionID: sub.id }))[0].info.id).toBe(first.id)
      },
    })
  }, 30_000)

  test("a stop that lands after a new child's prompt is written removes the child, and its debt with it", async () => {
    await using tmp = await project()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await root()
        const prompt = await user(parent.id, "go")
        const reply = await assistant(parent.id, prompt.id, "")

        // A real Stop, the moment the child's prompt is written and before the
        // launch's check after it. No turn runs here, so the abort the Stop's
        // cancel would deliver to the turn's tools is delivered by hand.
        const turn = new AbortController()
        const stop = { done: Promise.resolve() }
        const unsubscribe = Bus.subscribe(MessageV2.Event.Updated, (event) => {
          if (event.properties.info.role !== "user" || event.properties.info.sessionID === parent.id) return
          unsubscribe()
          turn.abort(SessionPrompt.STOPPED)
          stop.done = Session.stop({ sessionID: parent.id })
        })

        const run = await tool(parent.id, reply.id, turn.signal)

        await expect(run({})).rejects.toThrow(`session ${parent.id} was stopped before its subagent launched`)
        await stop.done
        expect(await Session.children(parent.id)).toEqual([])
        expect(await Debt.owed(parent.id)).toEqual([])
        expect(await Debt.owing(parent.id)).toBe(false)
      },
    })
  }, 30_000)

  test("a launch that fails before its prompt owes nothing and leaves no child behind", async () => {
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
        expect(children).toEqual([])
        expect(await Debt.owing(parent.id)).toBe(false)
      },
    })
  }, 30_000)
})

// Every message into a subagent goes through one write, whoever sends it:
// the agent tool, or a prompt route. Each case runs through both senders and
// must leave the same debt, transcript and reports.
describe("a message into a subagent", () => {
  const senders = {
    "the agent tool": async (parentID: string, childID: string, text: string) => {
      const prompt = await user(parentID, "go")
      const reply = await assistant(parentID, prompt.id, "")
      const called = await (await tool(parentID, reply.id))({ session_id: childID, prompt: text })
      return called.metadata.mode as string
    },
    "a prompt route": async (_parentID: string, childID: string, text: string) => {
      const sent = await SessionPrompt.send({
        model: Provider.DEFAULT,
        variant: Provider.DEFAULT,
        sessionID: childID,
        parts: [{ type: "text", text }],
      })
      return sent.message.debt === "joined" ? "steered" : "continued"
    },
  }
  const texts = async (sessionID: string) =>
    (await Session.messages({ sessionID }))
      .filter((m) => m.info.role === "user")
      .map((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text.split("<!--")[0]] : [])).join(""))

  for (const [name, send] of Object.entries(senders)) {
    describe(`sent by ${name}`, () => {
      test("into a child still owing joins its debt, and it reports once", async () => {
        await using tmp = await project()
        await Instance.provide({
          directory: tmp.path,
          fn: async () => {
            const parent = await root()
            const sub = await child(parent.id)
            const asked = await user(sub.id, "count")
            const cut = (await assistant(sub.id, asked.id, "partial")) as MessageV2.Assistant
            await Session.updateMessage({
              ...cut,
              error: { name: "MessageAbortedError", data: { message: "aborted" } },
            })
            const opened = await Debt.get(sub.id)
            state.replies.push("7 files", "noted", "noted")
            Recovery.start()

            expect(await send(parent.id, sub.id, "carry on")).toBe("steered")
            // The steer joined the open debt: same row, one more ask.
            expect(await Debt.get(sub.id)).toEqual({ ...opened!, asks: 1 })
            expect((await Session.children(parent.id)).map((c) => c.id)).toEqual([sub.id])
            await until(async () => !(await Debt.has(sub.id)), "the child to report")
            await until(async () => (await results(parent.id)).length === 1, "the report")
            // Idle on both sides, with the row gone: nothing is left that could
            // pay a second report.
            await until(() => !SessionBusy.busy(sub.id), `${sub.id} to go idle`)
            await answered(parent.id)
            expect(await Debt.has(sub.id)).toBe(false)
            expect(await results(parent.id)).toEqual(["completed"])
            expect(await texts(sub.id)).toEqual(["count", "carry on"])
          },
        })
      }, 30_000)

      test("into a child that already reported opens a new debt in the same child, and it reports again", async () => {
        await using tmp = await project()
        await Instance.provide({
          directory: tmp.path,
          fn: async () => {
            const parent = await root()
            const sub = await child(parent.id)
            const asked = await user(sub.id, "count")
            await assistant(sub.id, asked.id, "7")
            await Debt.remove(sub.id)
            state.replies.push("now 9", "noted", "noted")
            Recovery.start()

            expect(await send(parent.id, sub.id, "recount")).toBe("continued")
            const [prompt] = (await Session.messages({ sessionID: sub.id })).filter(
              (m) => m.info.role === "user" && m.info.id > asked.id,
            )
            expect(await Debt.get(sub.id)).toEqual({
              responder: sub.id,
              kind: "subagent",
              caller: parent.id,
              created: prompt.info.time.created,
              asks: 0,
            })
            expect((await Session.children(parent.id)).map((c) => c.id)).toEqual([sub.id])
            await until(async () => !(await Debt.has(sub.id)), "the child to report")
            await until(async () => (await results(parent.id)).length === 1, "the report")
            // Idle on both sides, with the row gone: nothing is left that could
            // pay a second report.
            await until(() => !SessionBusy.busy(sub.id), `${sub.id} to go idle`)
            await answered(parent.id)
            expect(await Debt.has(sub.id)).toBe(false)
            expect(await results(parent.id)).toEqual(["completed"])
            expect((await Session.get(sub.id)).time.archived).toBeUndefined()
            expect(await texts(sub.id)).toEqual(["count", "recount"])
          },
        })
      }, 30_000)
    })
  }

  test("a brand-new child's first message opens its debt in the same write", async () => {
    await using tmp = await project()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await root()
        const sub = await Session.create({ parentID: parent.id })
        made.push(sub.id)

        const sent = await SessionPrompt.send({
          model: Provider.DEFAULT,
          variant: Provider.DEFAULT,
          sessionID: sub.id,
          noReply: true,
          parts: [{ type: "text", text: "count" }],
        })

        expect(sent.message.debt).toBe("opened")
        expect(await Debt.get(sub.id)).toEqual({
          responder: sub.id,
          kind: "subagent",
          caller: parent.id,
          created: sent.message.info.time.created,
          asks: 0,
        })
        await sent.answer
      },
    })
  }, 30_000)

  test("a message landing after the report was judged keeps the debt open until it is answered", async () => {
    await using tmp = await project()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await root()
        const sub = await child(parent.id)
        const asked = await user(sub.id, "count")
        await assistant(sub.id, asked.id, "7")
        // The report is judged against the asks counted now; a real message
        // then lands in the child before the paying write.
        const judged = (await Debt.get(sub.id))!
        expect(judged.asks).toBe(0)
        const landed = await SessionPrompt.send({
          model: Provider.DEFAULT,
          variant: Provider.DEFAULT,
          sessionID: sub.id,
          noReply: true,
          parts: [{ type: "text", text: "and the tests?" }],
        })
        await landed.answer
        expect(landed.message.debt).toBe("joined")
        const report = {
          text: "7",
          synthetic: true,
          backgroundSubagentResult: {
            subagentId: sub.id,
            description: "count files",
            status: "completed" as const,
            sessionID: sub.id,
            duration: 0,
          },
        }

        const paid = await Recovery.deliver(parent.id, [report], sub.id, { wake: false, judged })

        expect(paid).toBe(false)
        expect(await Debt.get(sub.id)).toEqual({ ...judged, asks: 1 })
        expect(await results(parent.id)).toEqual([])

        // Judged again, against the ask that landed, the same report pays.
        expect(
          await Recovery.deliver(parent.id, [report], sub.id, { wake: false, judged: { ...judged, asks: 1 } }),
        ).toBe(true)
        expect(await Debt.has(sub.id)).toBe(false)
        expect(await results(parent.id)).toEqual(["completed"])
      },
    })
  }, 30_000)

  test("a payer that judged a debt already paid cannot pay the new one opened in its place", async () => {
    await using workspace = await project()
    await Instance.provide({
      directory: workspace.path,
      fn: async () => {
        const parent = await root()
        const sub = await child(parent.id)
        const asked = await user(sub.id, "count")
        await assistant(sub.id, asked.id, "7")
        const stale = (await Debt.get(sub.id))!
        const report = {
          text: "7",
          synthetic: true,
          backgroundSubagentResult: {
            subagentId: sub.id,
            description: "count files",
            status: "completed" as const,
            sessionID: sub.id,
            duration: 0,
          },
        }
        expect(await Recovery.deliver(parent.id, [report], sub.id, { wake: false, judged: stale })).toBe(true)

        // A new message opens a second debt with the same count of asks.
        await until(() => Date.now() > stale.created, "the clock to pass the first debt's creation")
        const reopened = await SessionPrompt.send({
          model: Provider.INHERIT,
          variant: Provider.INHERIT,
          sessionID: sub.id,
          noReply: true,
          parts: [{ type: "text", text: "and the tests?" }],
        })
        await reopened.answer
        const fresh = (await Debt.get(sub.id))!
        expect(fresh).toEqual({
          responder: sub.id,
          kind: "subagent",
          caller: parent.id,
          created: reopened.message.info.time.created,
          asks: stale.asks,
        })

        expect(await Recovery.deliver(parent.id, [report], sub.id, { wake: false, judged: stale })).toBe(false)
        expect(await Debt.get(sub.id)).toEqual(fresh)
        expect(await results(parent.id)).toEqual(["completed"])

        expect(await Recovery.deliver(parent.id, [report], sub.id, { wake: false, judged: fresh })).toBe(true)
        expect(await Debt.has(sub.id)).toBe(false)
        expect(await results(parent.id)).toEqual(["completed", "completed"])
      },
    })
  }, 30_000)

  test("into a root session opens no debt", async () => {
    await using tmp = await project()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await root()
        const sent = await SessionPrompt.send({
          model: Provider.DEFAULT,
          variant: Provider.DEFAULT,
          sessionID: session.id,
          noReply: true,
          parts: [{ type: "text", text: "hi" }],
        })
        expect(sent.message.debt).toBeUndefined()
        expect(await Debt.has(session.id)).toBe(false)
        await sent.answer
      },
    })
  }, 30_000)
})
