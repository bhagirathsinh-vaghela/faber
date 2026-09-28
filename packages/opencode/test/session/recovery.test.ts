import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { Recovery } from "../../src/session/recovery"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Db } from "../../src/storage/db"
import { Meta } from "../../src/storage/meta"
import { Owed } from "../../src/storage/owed"
import { Sessions } from "../../src/storage/sessions"
import { BackgroundJob } from "../../src/background/job"
import { SessionBusy } from "../../src/session/busy"
import { SessionPrompt } from "../../src/session/prompt"
import { Messages } from "../../src/storage/messages"
import { MessageV2 } from "../../src/session/message-v2"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const MODEL = "claude-3-5-sonnet-20241022"
const DEAD = 2 ** 22 + 12345

// A reply is a text answer, or a whole response for anything else (a tool
// call). A request can be held on a promise first, to observe a turn while its
// model call is still in flight.
const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  replies: [] as (string | (() => Response))[],
  holds: [] as (Promise<void> | undefined)[],
  requests: [] as unknown[],
}

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      state.requests.push(await req.json())
      const hold = state.holds.shift()
      if (hold) await hold
      const next = state.replies.shift() ?? "fallback"
      return typeof next === "string" ? reply(next) : next()
    },
  })
})

// Every session a test creates is stopped afterwards, so nothing it leaves
// owed or mid-turn is acted on by a later test's pass: recovery scans the
// whole shared database, not one test's rows.
const made: string[] = []

beforeEach(async () => {
  state.replies.length = 0
  state.holds.length = 0
  state.requests.length = 0
  Recovery.start()
  await Recovery.poke()
})

afterEach(async () => {
  const ids = made.splice(0)
  for (const id of ids)
    await Sessions.update(id, (draft) => {
      draft.time.stopped = Date.now() + 60_000
      draft.turn = undefined
    }).catch(() => {})
  // A wake still running would carry into the next test's requests. Cancel
  // needs the session's instance, which afterEach runs outside of.
  for (const id of ids.filter((id) => SessionBusy.busy(id))) {
    const session = await Sessions.read(id).catch(() => undefined)
    if (session) await Instance.provide({ directory: session.directory, fn: () => SessionPrompt.cancel(id) })
  }
  await until(() => ids.every((id) => !SessionBusy.busy(id)), "this test's turns to end", 5_000)
})

afterAll(() => {
  Recovery.stop()
  state.server?.stop()
})

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
  return sse(chunks)
}

function sse(chunks: unknown[]) {
  const payload = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n") + "\n\n"
  return new Response(payload, { status: 200, headers: { "Content-Type": "text/event-stream" } })
}

// A step that calls one tool and ends with `tool_use`, so the loop finishes the
// step and asks the model again.
function call(name: string, input: unknown) {
  return () =>
    sse([
      {
        type: "message_start",
        message: {
          id: "msg-1",
          model: MODEL,
          usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name, input: {} } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ])
}

async function until(check: () => Promise<boolean> | boolean, what: string, ms = 10_000) {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(10)
  }
}

async function withProject(fn: () => Promise<void>) {
  await using project = await tmpdir({
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
  await Instance.provide({ directory: project.path, fn })
}

const model = { providerID: "anthropic", modelID: MODEL }

async function user(sessionID: string, text: string, synthetic = false) {
  const info = await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model,
    ...(synthetic ? { synthetic: true } : {}),
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: info.id,
    sessionID,
    type: "text",
    text,
    ...(synthetic ? { synthetic: true } : {}),
  })
  return info
}

async function assistant(sessionID: string, parentID: string, text: string, finish: string | undefined = "stop") {
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
    time: { created: Date.now(), ...(finish ? { completed: Date.now() } : {}) },
    ...(finish ? { finish } : {}),
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: info.id,
    sessionID,
    type: "text",
    text,
  })
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

async function tick() {
  await Bun.sleep(5)
}

async function results(sessionID: string) {
  const messages = await Session.messages({ sessionID })
  return messages.flatMap((m) =>
    m.parts.flatMap((p) => (p.type === "text" && p.backgroundSubagentResult ? [p.backgroundSubagentResult] : [])),
  )
}

// A pass, then every turn it started run to its end: no queued reply left, no
// session of this test busy, and none holding a delivered message that its
// wake has not answered yet (the newest message a synthetic user one) or a
// reply still being written. A test that expects no turn to start passes
// `idle`: it waits for no session to be busy instead, since a delivered
// message nobody should answer is exactly what it leaves behind.
async function settle(options: { idle?: boolean } = {}) {
  await Recovery.poke()
  const read = await Messages.reader()
  const quiet = () =>
    made.every((id) => {
      if (SessionBusy.busy(id)) return false
      if (options.idle) return true
      const newest = read.newest(id)
      if (newest?.role === "assistant") return newest.time.completed !== undefined
      return !(newest?.role === "user" && newest.synthetic)
    }) &&
    (options.idle || state.replies.length === 0)
  await until(quiet, "the woken turns to finish", 15_000).catch(async (error) => {
    // Name what is still waiting, so a timeout says which session and why.
    const stuck = await Promise.all(
      made.map(async (id) => {
        const newest = read.newest(id)
        const stopped = (await Sessions.read(id).catch(() => undefined))?.time.stopped
        return `${id} busy=${SessionBusy.busy(id)} newest=${newest?.role}${newest?.role === "user" && newest.synthetic ? "(synthetic)" : ""} created=${newest?.time.created} stopped=${stopped}`
      }),
    )
    throw new Error(`${error.message}: replies left ${state.replies.length}; ${stuck.join("; ")}`)
  })
  await Recovery.poke()
}

async function texts(sessionID: string) {
  return (await Session.messages({ sessionID })).flatMap((m) =>
    m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])),
  )
}

describe("Recovery.owed", () => {
  test("follows the prompt, delivery, and stop facts", () => {
    const base = { parentID: "ses_p", time: { created: 1, updated: 1, injected: 0 } } as Session.Info
    expect(Recovery.owed(base, 5)).toBe(true)
    expect(Recovery.owed({ ...base, time: { ...base.time, injected: 6 } }, 5)).toBe(false)
    expect(Recovery.owed({ ...base, time: { ...base.time, stopped: 6 } }, 5)).toBe(false)
    expect(Recovery.owed({ ...base, time: { ...base.time, injected: 6 } }, 7)).toBe(true)
    expect(Recovery.owed({ ...base, time: { created: 1, updated: 1 } }, 5)).toBe(false)
    expect(Recovery.owed({ ...base, parentID: undefined }, 5)).toBe(false)
  })
})

describe("Recovery delivery", () => {
  test("a finished child is delivered once, and a second pass delivers nothing", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      const prompt = await user(sub.id, "count the files")
      await tick()
      await assistant(sub.id, prompt.id, "There are 7 files.")
      state.replies.push("Noted, 7 files.")

      await settle()
      await settle()

      const messages = await Session.messages({ sessionID: parent.id })
      const card = messages.find((m) => m.parts.some((p) => p.type === "text" && p.backgroundSubagentResult))!
      const part = card.parts.find((p) => p.type === "text")!
      expect(part.type === "text" && part.backgroundSubagentResult).toMatchObject({
        subagentId: sub.id,
        description: "count files",
        status: "completed",
        agent: "build",
        sessionID: sub.id,
      })
      expect(part.type === "text" && part.text).toContain("There are 7 files.")
      expect((await Session.get(sub.id)).time.injected).toBe(card.info.time.created)
      expect(state.requests.length).toBe(1)
    })
  }, 30_000)

  test("a child whose last turn errored is delivered as failed, with the error", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      const prompt = await user(sub.id, "count the files")
      await tick()
      const failed = await assistant(sub.id, prompt.id, "partial", undefined)
      await Session.updateMessage({
        ...failed,
        time: { ...failed.time, completed: Date.now() },
        error: { name: "UnknownError", data: { message: "provider exploded" } },
      } as typeof failed)
      state.replies.push("ok")

      await settle()

      expect((await results(parent.id)).map((r) => r.status)).toEqual(["failed"])
      expect((await texts(parent.id)).some((t) => t.includes("ERROR: provider exploded"))).toBe(true)
      expect((await Recovery.subagents(parent.id)).map((s) => s.status)).toEqual(["failed"])
    })
  }, 30_000)

  test("a child waiting on an unanswered message is not done, so nothing is delivered early", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      const prompt = await user(sub.id, "count the files")
      await tick()
      await assistant(sub.id, prompt.id, "first answer")
      await user(sub.id, "a job finished", true)

      expect(await Recovery.done(await Session.get(sub.id))).toBe(false)
    })
  }, 30_000)

  test("a stopped child delivers nothing and does not wake the parent", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      const prompt = await user(sub.id, "count the files")
      await tick()
      await assistant(sub.id, prompt.id, "partial")
      await Session.stop({ sessionID: sub.id })

      await settle({ idle: true })

      expect(await results(parent.id)).toEqual([])
      expect(state.requests.length).toBe(0)
    })
  }, 30_000)

  test("stopping the parent stops the child too, stamped no earlier", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      const prompt = await user(sub.id, "count the files")
      await tick()
      await assistant(sub.id, prompt.id, "partial")
      await Session.stop({ sessionID: parent.id })

      await settle({ idle: true })

      expect(await results(parent.id)).toEqual([])
      expect((await Session.get(sub.id)).time.stopped).toBeGreaterThanOrEqual((await Session.get(parent.id)).time.stopped!)
    })
  }, 30_000)

  test("prompting a stopped child again makes it owed and delivers the new answer", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      await user(sub.id, "count the files")
      await Session.stop({ sessionID: sub.id })
      await tick()
      const again = await user(sub.id, "try again")
      await tick()
      await assistant(sub.id, again.id, "Now 9 files.")
      state.replies.push("ok")

      await settle()

      expect((await results(parent.id)).map((r) => r.status)).toEqual(["completed"])
    })
  }, 30_000)

  test("a child whose finished job is not paid yet is not done", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      const prompt = await user(sub.id, "run it")
      await tick()
      await assistant(sub.id, prompt.id, "Started a job.")
      await BackgroundJob.write({
        id: "job_still_owed",
        sessionID: sub.id,
        directory: Instance.directory,
        project: Instance.directory,
        command: "true",
        description: "x",
        status: "exited",
        exit: 0,
        time: { created: Date.now() - 1000, hard: Date.now() + 60_000, completed: Date.now() },
      })
      await Owed.add("job_still_owed", sub.id)
      try {
        expect(await Recovery.done(await Session.get(sub.id))).toBe(false)
        await Owed.remove("job_still_owed")
        expect(await Recovery.done(await Session.get(sub.id))).toBe(true)
      } finally {
        await Owed.remove("job_still_owed")
        await BackgroundJob.remove("job_still_owed")
      }
    })
  }, 30_000)

  test("a settled job's result is delivered into its session once, paying the debt", async () => {
    await withProject(async () => {
      const session = await root()
      await user(session.id, "run it")
      await BackgroundJob.write({
        id: "job_settled_1",
        sessionID: session.id,
        directory: Instance.directory,
        project: Instance.directory,
        command: "echo hi",
        description: "say hi",
        status: "exited",
        exit: 0,
        time: { created: Date.now() - 1000, hard: Date.now() + 60_000, completed: Date.now() },
      })
      await Owed.add("job_settled_1", session.id)
      state.replies.push("Got it.")

      try {
        await settle()
        await settle()

        const jobs = (await Session.messages({ sessionID: session.id }))
          .flatMap((m) => m.parts)
          .flatMap((p) => (p.type === "text" && p.backgroundJobResult ? [p.backgroundJobResult.jobId] : []))
        expect(jobs).toEqual(["job_settled_1"])
        expect(await Owed.pending(session.id)).toBe(false)
        expect(state.requests.length).toBe(1)
      } finally {
        await Owed.remove("job_settled_1")
        await BackgroundJob.remove("job_settled_1")
      }
    })
  }, 30_000)

  test("stopping a session drops its debts, so a finished job's result is not posted", async () => {
    await withProject(async () => {
      const session = await root()
      await user(session.id, "run it")
      await BackgroundJob.write({
        id: "job_after_stop",
        sessionID: session.id,
        directory: Instance.directory,
        project: Instance.directory,
        command: "echo hi",
        description: "say hi",
        status: "exited",
        exit: 0,
        time: { created: Date.now() - 1000, hard: Date.now() + 60_000, completed: Date.now() },
      })
      await Owed.add("job_after_stop", session.id)
      await Session.stop({ sessionID: session.id })

      try {
        await settle({ idle: true })

        expect(await Owed.pending(session.id)).toBe(false)
        expect((await Session.messages({ sessionID: session.id })).length).toBe(1)
      } finally {
        await Owed.remove("job_after_stop")
        await BackgroundJob.remove("job_after_stop")
      }
    })
  }, 30_000)

  test("a child whose launch failed before its prompt was written reports failed to its parent", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)

      await Recovery.fail(sub.id, "agent not found", Date.now())

      expect((await results(parent.id)).map((r) => r.status)).toEqual(["failed"])
      expect((await texts(parent.id)).some((t) => t.includes("ERROR: agent not found"))).toBe(true)
      expect((await Recovery.subagents(parent.id)).map((s) => s.status)).toEqual(["failed"])
    })
  }, 30_000)

  test("a job left running by an interrupt (Esc) still delivers its result", async () => {
    await withProject(async () => {
      const session = await root()
      await user(session.id, "run it")
      await BackgroundJob.write({
        id: "job_after_interrupt",
        sessionID: session.id,
        directory: Instance.directory,
        project: Instance.directory,
        command: "echo hi",
        description: "say hi",
        status: "exited",
        exit: 0,
        time: { created: Date.now() - 1000, hard: Date.now() + 60_000, completed: Date.now() },
      })
      // The Esc first, then the debt: a pass already running could pay a debt
      // written before the Esc, and an Esc after a delivery rightly wins over
      // its wake. This test is about a result that settles after the Esc.
      await Session.interrupt(session.id)
      state.replies.push("Got it.")
      await Owed.add("job_after_interrupt", session.id)

      try {
        await settle()

        const jobs = (await Session.messages({ sessionID: session.id }))
          .flatMap((m) => m.parts)
          .flatMap((p) => (p.type === "text" && p.backgroundJobResult ? [p.backgroundJobResult.jobId] : []))
        expect(jobs).toEqual(["job_after_interrupt"])
        expect(await Owed.pending(session.id)).toBe(false)
      } finally {
        await Owed.remove("job_after_interrupt")
        await BackgroundJob.remove("job_after_interrupt")
      }
    })
  }, 30_000)

  // The order a real launch writes things in: the debt at spawn, while the job
  // is still running, then the Esc, then the job's exit.
  test("a job still running at an Esc delivers and wakes once it exits", async () => {
    await withProject(async () => {
      const session = await root()
      await user(session.id, "run it")
      await BackgroundJob.write({
        id: "job_through_interrupt",
        sessionID: session.id,
        directory: Instance.directory,
        project: Instance.directory,
        command: "echo hi",
        description: "say hi",
        status: "running",
        time: { created: Date.now() - 1000, hard: Date.now() + 60_000 },
      })
      await Owed.add("job_through_interrupt", session.id)
      try {
        await Session.interrupt(session.id)
        await tick()
        await BackgroundJob.update("job_through_interrupt", (draft) => {
          draft.status = "exited"
          draft.exit = 0
          draft.time.completed = Date.now()
        })
        state.replies.push("Got it.")

        await settle()

        const jobs = (await Session.messages({ sessionID: session.id }))
          .flatMap((m) => m.parts)
          .flatMap((p) => (p.type === "text" && p.backgroundJobResult ? [p.backgroundJobResult.jobId] : []))
        expect(jobs).toEqual(["job_through_interrupt"])
        expect(await texts(session.id)).toContain("Got it.")
        expect(await Owed.pending(session.id)).toBe(false)
      } finally {
        await Owed.remove("job_through_interrupt")
        await BackgroundJob.remove("job_through_interrupt")
      }
    })
  }, 30_000)

  test("a delivery after a same-millisecond stop sorts after it, and a later-dated stop never dates it ahead", async () => {
    await withProject(async () => {
      const tied = await root()
      await user(tied.id, "a")
      const now = Date.now()
      await Session.update(tied.id, (draft) => void (draft.time.stopped = now))
      const job = "job_time_bound"
      await Owed.add(job, tied.id)
      try {
        expect(await Recovery.deliver(tied.id, [{ text: "tied", synthetic: true }], { kind: "job", job }, false)).toBe(
          true,
        )
        const tie = (await Session.messages({ sessionID: tied.id })).at(-1)!.info
        expect(tie.time.created).toBeGreaterThan(now)

        const ahead = await root()
        await user(ahead.id, "b")
        await Session.update(ahead.id, (draft) => void (draft.time.stopped = Date.now() + 10_000))
        await Owed.add(job, ahead.id)
        const before = Date.now()
        expect(
          await Recovery.deliver(ahead.id, [{ text: "ahead", synthetic: true }], { kind: "job", job }, false),
        ).toBe(true)
        const after = Date.now()
        const bounded = (await Session.messages({ sessionID: ahead.id })).at(-1)!.info
        expect(bounded.time.created).toBeGreaterThan(before)
        expect(bounded.time.created).toBeLessThanOrEqual(after + 1)
        // A reply written once the clock has passed the delivery sorts after
        // it; the bound is what makes that wait at most a millisecond.
        while (Date.now() <= bounded.time.created) await Bun.sleep(1)
        const later = await user(ahead.id, "c")
        const order = (await Session.messages({ sessionID: ahead.id })).map((m) => m.info.id)
        expect(order.indexOf(later.id)).toBeGreaterThan(order.indexOf(bounded.id))
      } finally {
        await Owed.remove(job)
      }
    })
  }, 30_000)

  test("an owed child whose parent is gone stops being owed", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      const prompt = await user(sub.id, "count")
      await tick()
      await assistant(sub.id, prompt.id, "7")
      await Sessions.remove(parent.id)

      await settle({ idle: true })

      expect((await Sessions.listOwed()).map((s) => s.id)).not.toContain(sub.id)
    })
  }, 30_000)

  test("the delivery transaction writes nothing when the claim is lost", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      const prompt = await user(sub.id, "x")
      await Session.update(sub.id, (draft) => void (draft.time.injected = Date.now() + 10_000))
      const delivered = await Recovery.deliver(parent.id, [{ text: "r", synthetic: true }], {
        kind: "subagent",
        child: sub.id,
        status: "completed",
        prompted: prompt.time.created,
      })
      expect(delivered).toBe(false)
      expect(await Session.messages({ sessionID: parent.id })).toEqual([])
    })
  }, 30_000)

  test("a delivery that fails after writing its message rolls back the message and the payment", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      const prompt = await user(sub.id, "x")
      // Serializing the part throws inside the transaction, after the message
      // row has already been written.
      const broken = { text: "r", synthetic: true, metadata: { size: 1n } } as unknown as Recovery.Part

      await expect(
        Recovery.deliver(
          parent.id,
          [broken],
          { kind: "subagent", child: sub.id, status: "completed", prompted: prompt.time.created },
          false,
        ),
      ).rejects.toThrow("JSON.stringify cannot serialize BigInt.")

      expect(await Session.messages({ sessionID: parent.id })).toEqual([])
      expect((await Sessions.read(sub.id)).time.injected).toBe(0)
      expect((await Sessions.listOwed()).map((s) => s.id)).toContain(sub.id)
    })
  }, 30_000)
})

describe("Recovery resume", () => {
  test("a turn cut by a dead process gets one continue prompt; a stopped one gets none", async () => {
    await withProject(async () => {
      const cut = await root()
      await user(cut.id, "do the thing")
      await Session.mark(cut.id, (draft) => void (draft.turn = { at: Date.now(), pid: DEAD }))
      const stopped = await root()
      await user(stopped.id, "other thing")
      await Session.mark(stopped.id, (draft) => void (draft.turn = { at: Date.now() - 10, pid: DEAD }))
      await Session.update(stopped.id, (draft) => void (draft.time.stopped = Date.now()))
      state.replies.push("Resumed.")

      await settle()

      expect(await texts(cut.id)).toEqual(["do the thing", Recovery.parentResumeText(0), "Resumed."])
      expect((await Session.get(cut.id)).turn).toBeUndefined()
      expect((await Session.get(stopped.id)).turn).toBeUndefined()
      expect(await texts(stopped.id)).toEqual(["other thing"])
      expect(state.requests.length).toBe(1)
    })
  }, 30_000)

  test("a marker whose pid is alive but started at another time is a cut turn", async () => {
    await withProject(async () => {
      const cut = await root()
      await user(cut.id, "do the thing")
      await Session.mark(cut.id, (draft) => void (draft.turn = { at: Date.now(), pid: process.pid, boot: 1 }))
      expect(await Recovery.cut(await Session.get(cut.id))).toBe(true)
      await Session.mark(
        cut.id,
        (draft) => void (draft.turn = { at: Date.now(), pid: process.pid, boot: Recovery.boot }),
      )
      expect(await Recovery.cut(await Session.get(cut.id))).toBe(false)
    })
  }, 30_000)

  test("the resume count carries across cuts and resets once a step finishes", async () => {
    await withProject(async () => {
      const session = await root()
      await user(session.id, "do the thing")
      await Session.mark(session.id, (draft) => void (draft.turn = { at: Date.now(), pid: DEAD }))
      const first = Promise.withResolvers<void>()
      const second = Promise.withResolvers<void>()
      const third = Promise.withResolvers<void>()
      state.holds.push(first.promise, second.promise, third.promise)
      // The first reply goes to the turn that gets cut, which never reads it.
      state.replies.push("unread", call("read", { filePath: path.join(Instance.directory, "missing.txt") }), "Done.")

      await Recovery.poke()
      await until(() => state.requests.length === 1, "the first resume's model call")
      expect((await Session.get(session.id)).turn?.resumes).toBe(1)

      // The process running the resumed turn dies: its marker now names a
      // dead pid, and the turn never finishes a step.
      await Session.mark(session.id, (draft) => void (draft.turn = { ...draft.turn!, pid: DEAD }))
      SessionPrompt.cancel(session.id)
      first.resolve()
      await until(() => !SessionBusy.busy(session.id), "the cut turn to unwind")

      await Recovery.poke()
      await until(() => state.requests.length === 2, "the second resume's model call")
      expect((await Session.get(session.id)).turn?.resumes).toBe(2)

      second.resolve()
      await until(() => state.requests.length === 3, "the step after the tool call")
      expect((await Session.get(session.id)).turn?.resumes).toBe(0)

      third.resolve()
      await until(() => !SessionBusy.busy(session.id), "the turn to end")
      expect((await Session.get(session.id)).turn).toBeUndefined()
      expect(state.replies.length).toBe(0)
    })
  }, 30_000)

  test("gives up after the cap, delivering a failed result for an owed child", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      await user(sub.id, "count")
      await Session.mark(sub.id, (draft) => void (draft.turn = { at: Date.now(), pid: DEAD, resumes: Recovery.CAP }))
      state.replies.push("ok")

      await settle()

      expect((await results(parent.id)).map((r) => r.status)).toEqual(["failed"])
      expect((await Session.get(sub.id)).turn).toBeUndefined()
    })
  }, 30_000)
})

describe("Recovery after a lost wake", () => {
  test("a result delivered but never answered is woken by a later pass", async () => {
    await withProject(async () => {
      const session = await root()
      await user(session.id, "start")
      // A delivered result whose wake was lost: synthetic, newest, no turn,
      // written longer ago than a wake is given to answer it.
      const waiting = await Session.updateMessage({
        id: Identifier.ascending("message"),
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() - 20_000 },
        agent: "build",
        model,
        synthetic: true,
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: waiting.id,
        sessionID: session.id,
        type: "text",
        text: "result",
        synthetic: true,
      })
      state.replies.push("Read it.")

      await settle()

      expect(await texts(session.id)).toEqual(["start", "result", "Read it."])
    })
  }, 30_000)

  test("a person's unanswered message and a stopped session are left alone", async () => {
    await withProject(async () => {
      const typed = await root()
      await Session.updateMessage({
        id: Identifier.ascending("message"),
        sessionID: typed.id,
        role: "user",
        time: { created: Date.now() - 20_000 },
        agent: "build",
        model,
      })
      // Old enough to be picked up on age alone, so only the stop excludes it.
      const stopped = await root()
      const waiting = await Session.updateMessage({
        id: Identifier.ascending("message"),
        sessionID: stopped.id,
        role: "user",
        time: { created: Date.now() - 20_000 },
        agent: "build",
        model,
        synthetic: true,
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: waiting.id,
        sessionID: stopped.id,
        type: "text",
        text: "result",
        synthetic: true,
      })
      await Session.update(stopped.id, (draft) => void (draft.time.stopped = Date.now()))

      await settle({ idle: true })

      expect(state.requests.length).toBe(0)
      const unanswered = (await Sessions.listUnanswered(Date.now())).map((s) => s.id)
      expect(unanswered.includes(typed.id)).toBe(false)
      expect(unanswered.includes(stopped.id)).toBe(false)
    })
  }, 30_000)

  test("a subagent that no longer reports is not woken by a job result", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      const prompt = await user(sub.id, "count")
      await assistant(sub.id, prompt.id, "7")
      await Session.update(sub.id, (draft) => void (draft.time.injected = Date.now() + 1))
      await BackgroundJob.write({
        id: "job_into_finished_child",
        sessionID: sub.id,
        directory: Instance.directory,
        project: Instance.directory,
        command: "echo hi",
        description: "say hi",
        status: "exited",
        exit: 0,
        time: { created: Date.now() - 1000, hard: Date.now() + 60_000, completed: Date.now() },
      })
      await Owed.add("job_into_finished_child", sub.id)

      try {
        await settle({ idle: true })

        expect(await Owed.pending(sub.id)).toBe(false)
        expect(state.requests.length).toBe(0)
      } finally {
        await Owed.remove("job_into_finished_child")
        await BackgroundJob.remove("job_into_finished_child")
      }
    })
  }, 30_000)
})

describe("Recovery launch failures", () => {
  test("a child launched before this process that never got its prompt reports failed", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      await Sessions.update(sub.id, (draft) => void (draft.time.created = Recovery.boot * 1000 - 5000))

      await settle()

      expect((await results(parent.id)).map((r) => r.status)).toEqual(["failed"])
      expect((await texts(parent.id)).some((t) => t.includes("the server stopped before this subagent started"))).toBe(
        true,
      )
      expect((await Recovery.subagents(parent.id)).map((s) => s.status)).toEqual(["failed"])
    })
  }, 30_000)

  test("a continued child whose second prompt failed reports it once", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      const prompt = await user(sub.id, "count")
      await assistant(sub.id, prompt.id, "7")
      await Session.update(sub.id, (draft) => void (draft.time.injected = Date.now()))
      await tick()
      const launched = Date.now()

      await Recovery.fail(sub.id, "model unavailable", launched)
      await Recovery.fail(sub.id, "model unavailable", launched)

      expect((await results(parent.id)).map((r) => r.status)).toEqual(["failed"])
      expect((await Recovery.subagents(parent.id)).map((s) => s.status)).toEqual(["failed"])
    })
  }, 30_000)
})

describe("Recovery transient turns", () => {
  test("a cut turn from a process that does not recover is dropped, and its child reports failed", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      await user(sub.id, "count")
      await Session.mark(sub.id, (draft) => void (draft.turn = { at: Date.now(), pid: DEAD, transient: true }))

      await settle({ idle: true })

      expect((await Session.get(sub.id)).turn).toBeUndefined()
      expect(await texts(sub.id)).toEqual(["count"])
      expect((await texts(parent.id)).some((t) => t.includes("the process running it exited before it finished"))).toBe(
        true,
      )
    })
  }, 30_000)

  test("a cut turn left behind does not report for a newer launch's prompt", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      // A marker a dead transient process left, then a launch's prompt that
      // landed before that launch's own turn marked the session.
      await Session.mark(sub.id, (draft) => void (draft.turn = { at: Date.now(), pid: DEAD, transient: true }))
      await tick()
      await user(sub.id, "count again")

      await settle({ idle: true })

      expect((await Session.get(sub.id)).turn).toBeUndefined()
      expect((await results(parent.id)).filter((r) => r.status === "failed")).toEqual([])
    })
  }, 30_000)

  test("a prompt that joined a transient turn whose process left is not answered early", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      await Session.mark(sub.id, (draft) => {
        draft.turn = { at: Date.now(), pid: DEAD, transient: true }
        draft.left = { pid: DEAD, boot: 1 }
      })
      await tick()
      await user(sub.id, "count")

      await settle({ idle: true })

      // Not the cut turn's own prompt, and not yet past SETTLE_MS.
      expect((await Session.get(sub.id)).turn).toBeUndefined()
      expect(await results(parent.id)).toEqual([])
      expect(state.requests.length).toBe(0)
    })
  }, 30_000)

  test("a subagent its transient process left owed reports failed once its prompt has waited, and runs nothing", async () => {
    await withProject(async () => {
      // Dated past SETTLE_MS but after this process began, which the
      // first-boot baseline would otherwise stop as history.
      await until(() => Date.now() - Recovery.boot * 1000 > 16_000, "the process to be older than SETTLE_MS", 25_000)
      const parent = await root()
      const sub = await child(parent.id)
      // A prompt never counts from before its session was made.
      await Session.mark(sub.id, (draft) => {
        draft.left = { pid: DEAD, boot: 1 }
        draft.time.created = Date.now() - 14_000
      })
      const prompt = await user(sub.id, "count")
      const waited = Date.now() - 13_000
      await Session.updateMessage({ ...prompt, time: { created: waited } })
      expect((await Messages.reader()).prompted(sub.id)).toBe(waited)
      // The parent's reader is here, so the result wakes it as any other does.
      state.replies.push("noted")

      await settle()

      expect((await results(parent.id)).map((r) => r.status)).toEqual(["failed"])
      expect(await texts(sub.id)).toEqual(["count"])
      expect(await texts(parent.id)).toContain("noted")
    })
  }, 40_000)

  test("a subagent that answered before its transient process left reports that answer, not a failure", async () => {
    await withProject(async () => {
      await until(() => Date.now() - Recovery.boot * 1000 > 16_000, "the process to be older than SETTLE_MS", 25_000)
      const parent = await root()
      const sub = await child(parent.id)
      await Session.mark(sub.id, (draft) => {
        draft.left = { pid: DEAD, boot: 1 }
        draft.time.created = Date.now() - 14_000
      })
      const prompt = await user(sub.id, "count")
      await Session.updateMessage({ ...prompt, time: { created: Date.now() - 13_000 } })
      await assistant(sub.id, prompt.id, "7 files")
      state.replies.push("noted")

      // A job it left running lands after its answer, and its delivery wakes
      // the child as any job result does.
      const job = "job_after_answer"
      await Owed.add(job, sub.id)
      try {
        expect(await Recovery.deliver(sub.id, [{ text: "job done", synthetic: true }], { kind: "job", job })).toBe(true)
        await until(async () => (await results(parent.id)).length > 0, "the child's result to reach its parent")
        await settle({ idle: true })
      } finally {
        await Owed.remove(job)
      }

      expect((await results(parent.id)).map((r) => r.status)).toEqual(["completed"])
      expect((await texts(parent.id)).some((t) => t.includes("7 files"))).toBe(true)
      expect(await texts(sub.id)).toEqual(["count", "7 files", "job done"])
    })
  }, 40_000)

  test("a subagent whose turn went on past a job result mid-turn reports its final answer", async () => {
    await withProject(async () => {
      await until(() => Date.now() - Recovery.boot * 1000 > 16_000, "the process to be older than SETTLE_MS", 25_000)
      const parent = await root()
      const sub = await child(parent.id)
      await Session.mark(sub.id, (draft) => {
        draft.left = { pid: DEAD, boot: 1 }
        draft.time.created = Date.now() - 14_000
      })
      const prompt = await user(sub.id, "count")
      await Session.updateMessage({ ...prompt, time: { created: Date.now() - 13_000 } })
      await assistant(sub.id, prompt.id, "let me look first", "tool-calls")
      // A job result landed mid-turn; the rest of the turn links to it.
      const landed = await user(sub.id, "first job done", true)
      await assistant(sub.id, landed.id, "7 files")
      state.replies.push("noted")

      const job = "job_after_final"
      await Owed.add(job, sub.id)
      try {
        expect(await Recovery.deliver(sub.id, [{ text: "second job done", synthetic: true }], { kind: "job", job })).toBe(true)
        await until(async () => (await results(parent.id)).length > 0, "the child's result to reach its parent")
        await settle({ idle: true })
      } finally {
        await Owed.remove(job)
      }

      expect((await results(parent.id)).map((r) => r.status)).toEqual(["completed"])
      expect((await texts(parent.id)).some((t) => t.includes("7 files"))).toBe(true)
    })
  }, 40_000)

  test("a subagent its transient process left between steps reports failed, not the step's text", async () => {
    await withProject(async () => {
      await until(() => Date.now() - Recovery.boot * 1000 > 16_000, "the process to be older than SETTLE_MS", 25_000)
      const parent = await root()
      const sub = await child(parent.id)
      await Session.mark(sub.id, (draft) => {
        draft.left = { pid: DEAD, boot: 1 }
        draft.time.created = Date.now() - 14_000
      })
      const prompt = await user(sub.id, "count")
      await Session.updateMessage({ ...prompt, time: { created: Date.now() - 13_000 } })
      // A finished step that asked for tools: more of the turn was coming.
      await assistant(sub.id, prompt.id, "let me look first", "tool-calls")
      state.replies.push("noted")

      const job = "job_between_steps"
      await Owed.add(job, sub.id)
      try {
        expect(await Recovery.deliver(sub.id, [{ text: "job done", synthetic: true }], { kind: "job", job })).toBe(true)
        await until(async () => (await results(parent.id)).length > 0, "the child's result to reach its parent")
        await settle({ idle: true })
      } finally {
        await Owed.remove(job)
      }

      expect((await results(parent.id)).map((r) => r.status)).toEqual(["failed"])
      expect((await texts(parent.id)).some((t) => t.includes("let me look first"))).toBe(false)
      expect((await texts(parent.id)).some((t) => t.includes("it stopped before it answered its prompt"))).toBe(true)
    })
  }, 40_000)

  test("a subagent whose last step errored after its process left reports that error, past any summary", async () => {
    await withProject(async () => {
      await until(() => Date.now() - Recovery.boot * 1000 > 16_000, "the process to be older than SETTLE_MS", 25_000)
      const parent = await root()
      const sub = await child(parent.id)
      await Session.mark(sub.id, (draft) => {
        draft.left = { pid: DEAD, boot: 1 }
        draft.time.created = Date.now() - 14_000
      })
      const prompt = await user(sub.id, "count")
      await Session.updateMessage({ ...prompt, time: { created: Date.now() - 13_000 } })
      // A compaction mid-turn: its summary step, then a step that errored.
      const compaction = await user(sub.id, "compact", true)
      const summary = (await assistant(sub.id, compaction.id, "summary of the work so far")) as MessageV2.Assistant
      await Session.updateMessage({ ...summary, summary: true })
      const failed = (await assistant(sub.id, compaction.id, "", undefined)) as MessageV2.Assistant
      await Session.updateMessage({
        ...failed,
        error: { name: "APIError", data: { message: "overloaded", isRetryable: false } },
      })
      state.replies.push("noted")

      const job = "job_after_error"
      await Owed.add(job, sub.id)
      try {
        expect(await Recovery.deliver(sub.id, [{ text: "job done", synthetic: true }], { kind: "job", job })).toBe(true)
        await until(async () => (await results(parent.id)).length > 0, "the child's result to reach its parent")
        await settle({ idle: true })
      } finally {
        await Owed.remove(job)
      }

      expect((await results(parent.id)).map((r) => r.status)).toEqual(["failed"])
      const said = await texts(parent.id)
      expect(said.some((t) => t.includes("ERROR: overloaded"))).toBe(true)
      expect(said.some((t) => t.includes("summary of the work so far"))).toBe(false)
    })
  }, 40_000)

  test("a subagent whose turn ended at a compaction's summary reports no answer, not the summary", async () => {
    await withProject(async () => {
      await until(() => Date.now() - Recovery.boot * 1000 > 16_000, "the process to be older than SETTLE_MS", 25_000)
      const parent = await root()
      const sub = await child(parent.id)
      await Session.mark(sub.id, (draft) => {
        draft.left = { pid: DEAD, boot: 1 }
        draft.time.created = Date.now() - 14_000
      })
      const prompt = await user(sub.id, "count")
      await Session.updateMessage({ ...prompt, time: { created: Date.now() - 13_000 } })
      await assistant(sub.id, prompt.id, "let me look first", "tool-calls")
      const compaction = await user(sub.id, "compact", true)
      const summary = (await assistant(sub.id, compaction.id, "summary of the work so far")) as MessageV2.Assistant
      await Session.updateMessage({ ...summary, summary: true })
      state.replies.push("noted")

      const job = "job_after_summary"
      await Owed.add(job, sub.id)
      try {
        expect(await Recovery.deliver(sub.id, [{ text: "job done", synthetic: true }], { kind: "job", job })).toBe(true)
        await until(async () => (await results(parent.id)).length > 0, "the child's result to reach its parent")
        await settle({ idle: true })
      } finally {
        await Owed.remove(job)
      }

      expect((await results(parent.id)).map((r) => r.status)).toEqual(["failed"])
      expect((await texts(parent.id)).some((t) => t.includes("summary of the work so far"))).toBe(false)
    })
  }, 40_000)

  test("a subagent its transient process left owed to a parent that is gone stops owing it", async () => {
    await withProject(async () => {
      await until(() => Date.now() - Recovery.boot * 1000 > 16_000, "the process to be older than SETTLE_MS", 25_000)
      const parent = await root()
      const sub = await child(parent.id)
      await Session.mark(sub.id, (draft) => {
        draft.left = { pid: DEAD, boot: 1 }
        draft.time.created = Date.now() - 14_000
      })
      const prompt = await user(sub.id, "count")
      await Session.updateMessage({ ...prompt, time: { created: Date.now() - 13_000 } })
      await Sessions.remove(parent.id)

      // A job result it left running lands, and wakes it.
      const job = "job_for_gone_parent"
      await Owed.add(job, sub.id)
      try {
        expect(await Recovery.deliver(sub.id, [{ text: "job done", synthetic: true }], { kind: "job", job })).toBe(true)
        await until(async () => (await Sessions.read(sub.id)).time.stopped !== undefined, "the child to stop owing")
      } finally {
        await Owed.remove(job)
      }

      const orphaned = await Sessions.read(sub.id)
      expect(Recovery.owed(orphaned, (await Messages.reader()).prompted(sub.id))).toBe(false)
    })
  }, 40_000)

  test("a subagent its transient process left owed with its cut turn still marked is left to resume", async () => {
    await withProject(async () => {
      await until(() => Date.now() - Recovery.boot * 1000 > 16_000, "the process to be older than SETTLE_MS", 25_000)
      const parent = await root()
      const sub = await child(parent.id)
      await Session.mark(sub.id, (draft) => {
        draft.left = { pid: DEAD, boot: 1 }
        draft.time.created = Date.now() - 14_000
      })
      const prompt = await user(sub.id, "count")
      await Session.updateMessage({ ...prompt, time: { created: Date.now() - 13_000 } })
      await assistant(sub.id, prompt.id, "7 files")
      await Session.mark(sub.id, (draft) => void (draft.turn = { at: Date.now(), pid: DEAD, transient: true }))

      const job = "job_under_marker"
      await Owed.add(job, sub.id)
      // Only the child's own wake runs; a pass would resume the cut turn. The
      // wake is not awaited by deliver, so the parent is watched for long
      // enough that a report from it would have landed (a report is one
      // delivery, well under this).
      Recovery.stop()
      try {
        expect(await Recovery.deliver(sub.id, [{ text: "job done", synthetic: true }], { kind: "job", job })).toBe(true)
        const reported = await until(async () => (await results(parent.id)).length > 0, "a report", 1500).then(
          () => true,
          () => false,
        )
        expect(reported).toBe(false)
        expect((await Session.get(sub.id)).turn?.pid).toBe(DEAD)
      } finally {
        await Owed.remove(job)
        Recovery.start()
      }
    })
  }, 40_000)
})

describe("Recovery.deliver judged against a prompt", () => {
  test("a report judged against an earlier prompt is refused once a newer one lands", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      const first = await user(sub.id, "count")
      await tick()
      // A launch continuing the child lands while the report was being built.
      await user(sub.id, "count again")

      const paid = await Recovery.deliver(parent.id, [{ text: "stale", synthetic: true }], {
        kind: "subagent",
        child: sub.id,
        status: "failed",
        prompted: first.time.created,
      })

      expect(paid).toBe(false)
      expect(await texts(parent.id)).toEqual([])
      expect(Recovery.owed(await Session.get(sub.id), (await Messages.reader()).prompted(sub.id))).toBe(true)
    })
  }, 30_000)

  test("a failure for an earlier prompt pays nothing once a newer launch prompts the child", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      const first = await user(sub.id, "count")
      await tick()
      await user(sub.id, "count again")

      await Recovery.fail(sub.id, "the wake kept failing", first.time.created, first.time.created)

      expect(await results(parent.id)).toEqual([])
      expect(Recovery.owed(await Session.get(sub.id), (await Messages.reader()).prompted(sub.id))).toBe(true)
    })
  }, 30_000)
})

describe("Recovery job strikes", () => {
  test("a job whose delivery throws is kept for a retry, then recorded lost", async () => {
    await withProject(async () => {
      const session = await root()
      await BackgroundJob.write({
        id: "job_throws",
        sessionID: session.id,
        directory: Instance.directory,
        project: Instance.directory,
        description: "no command",
        status: "exited",
        exit: 0,
        time: { created: Date.now() - 1000, hard: Date.now() + 60_000, completed: Date.now() },
      } as unknown as BackgroundJob.Info)
      await Owed.add("job_throws", session.id)

      try {
        await Recovery.poke()
        expect(await Owed.pending(session.id)).toBe(true)
        await Recovery.poke()
        expect(await Owed.pending(session.id)).toBe(true)
        await Recovery.poke()

        expect(await Owed.pending(session.id)).toBe(false)
        expect((await BackgroundJob.get("job_throws"))?.time.lost).toBeGreaterThan(0)
      } finally {
        await Owed.remove("job_throws")
        await BackgroundJob.remove("job_throws")
      }
    })
  }, 30_000)
})

describe("Recovery.baseline", () => {
  test("stops what predates this process exactly once per database, and makes running jobs owed", async () => {
    await withProject(async () => {
      const parent = await root()
      const old = await child(parent.id)
      await Session.updateMessage({
        id: Identifier.ascending("message"),
        sessionID: old.id,
        role: "user",
        time: { created: Recovery.boot * 1000 - 5000 },
        agent: "build",
        model,
      })
      const fresh = await child(parent.id)
      await user(fresh.id, "new work")
      const cut = await root()
      await Session.mark(cut.id, (draft) => void (draft.turn = { at: 1, pid: DEAD }))
      await BackgroundJob.write({
        id: "job_baseline_running",
        sessionID: cut.id,
        directory: Instance.directory,
        command: "true",
        description: "x",
        status: "running",
        // Before boot, so baseline's own stamp on `cut` would suppress it.
        time: { created: Recovery.boot * 1000 - 2000, hard: Date.now() + 60_000 },
      })
      ;(await Db.open()).run(`DELETE FROM meta WHERE key = 'recovery.baseline'`)

      try {
        await Recovery.baseline()

        expect((await Meta.get("recovery.baseline"))?.startsWith("done")).toBe(true)
        expect((await Session.get(old.id)).time.stopped).toBe(Recovery.boot * 1000 - 1)
        expect((await Session.get(fresh.id)).time.stopped).toBeUndefined()
        expect((await Session.get(cut.id)).turn).toBeUndefined()
        expect(await Owed.pending(cut.id)).toBe(true)
        expect(await Recovery.baseline()).toBe(0)
      } finally {
        await Owed.remove("job_baseline_running")
        await BackgroundJob.remove("job_baseline_running")
      }
    })
  }, 30_000)
})

describe("Recovery.lease", () => {
  test("one live process holds it; a dead holder's lease is taken over", async () => {
    await withProject(async () => {
      try {
        await Meta.update("recovery.lease", () => JSON.stringify({ pid: DEAD, at: Date.now() }))
        expect(await Recovery.lease()).toBe(true)
        const held = JSON.parse((await Meta.get("recovery.lease"))!)
        expect([held.pid, held.boot]).toEqual([process.pid, Recovery.boot])
        await Meta.update("recovery.lease", () => JSON.stringify({ pid: process.ppid, at: Date.now() }))
        expect(await Recovery.lease()).toBe(false)
      } finally {
        await Meta.update("recovery.lease", () =>
          JSON.stringify({ pid: process.pid, boot: Recovery.boot, at: Date.now() }),
        )
      }
    })
  }, 30_000)

  test("a live holder that stopped renewing loses the lease once it expires", async () => {
    await withProject(async () => {
      const stale = Date.now() - 3 * Recovery.SWEEP_MS - 1000
      await Meta.update("recovery.lease", () => JSON.stringify({ pid: process.ppid, at: stale }))
      expect(await Recovery.lease()).toBe(true)
      const held = JSON.parse((await Meta.get("recovery.lease"))!)
      expect([held.pid, held.boot]).toEqual([process.pid, Recovery.boot])
    })
  }, 30_000)

  test("this pid with another start time is an earlier process, so the lease is taken", async () => {
    await withProject(async () => {
      await Meta.update("recovery.lease", () =>
        JSON.stringify({ pid: process.pid, boot: Recovery.boot - 100, at: Date.now() }),
      )
      expect(await Recovery.lease()).toBe(true)
      const held = JSON.parse((await Meta.get("recovery.lease"))!)
      expect([held.pid, held.boot]).toEqual([process.pid, Recovery.boot])
    })
  }, 30_000)
})

describe("Session.stop", () => {
  test("stamps a session before its children, each when written, and every stamp before any cancel", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      const grandchild = await child(sub.id)
      // Observes the order only; the real cancel still runs. Each cancel reads
      // the stamps straight from the database.
      const read = await Sessions.reader()
      const ids = [parent.id, sub.id, grandchild.id]
      const seen: { id: string; stamped: boolean; cleared: number }[] = []
      const cleared: string[] = []
      const cancel = SessionPrompt.cancel
      const remove = Owed.removeSession
      SessionPrompt.cancel = (sessionID: string) => {
        seen.push({
          id: sessionID,
          stamped: ids.every((id) => (read(id)?.time.stopped ?? 0) > 0),
          cleared: cleared.length,
        })
        return cancel(sessionID)
      }
      Owed.removeSession = (sessionID: string) => {
        cleared.push(sessionID)
        return remove(sessionID)
      }
      const before = Date.now()
      try {
        await Session.stop({ sessionID: parent.id })
      } finally {
        SessionPrompt.cancel = cancel
        Owed.removeSession = remove
      }

      const stamps = (await Promise.all([parent, sub, grandchild].map((s) => Session.get(s.id)))).map(
        (s) => s.time.stopped!,
      )
      expect(seen.map((s) => s.id)).toEqual([grandchild.id, sub.id, parent.id])
      expect(stamps.every((t) => t >= before)).toBe(true)
      expect(stamps).toEqual([...stamps].sort((x, y) => x - y))
      // Every stamp and every debt removal lands before the first cancel.
      expect(seen.map((s) => [s.stamped, s.cleared])).toEqual([
        [true, 3],
        [true, 3],
        [true, 3],
      ])
      expect(cleared).toEqual([parent.id, sub.id, grandchild.id])
    })
  }, 30_000)

  test("a child whose debts cannot be dropped still has its subtree stopped, and the stop reports it", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      const grandchild = await child(sub.id)
      const cancelled: string[] = []
      const cancel = SessionPrompt.cancel
      const remove = Owed.removeSession
      SessionPrompt.cancel = (sessionID: string) => {
        cancelled.push(sessionID)
        return cancel(sessionID)
      }
      Owed.removeSession = async (sessionID: string) => {
        if (sessionID === sub.id) throw new Error(`could not drop the debts of ${sessionID}`)
        return remove(sessionID)
      }
      try {
        await expect(Session.stop({ sessionID: parent.id })).rejects.toThrow(`could not drop the debts of ${sub.id}`)
      } finally {
        SessionPrompt.cancel = cancel
        Owed.removeSession = remove
      }

      expect(cancelled).toEqual([grandchild.id, sub.id, parent.id])
      for (const id of [parent.id, sub.id, grandchild.id]) expect((await Session.get(id)).time.stopped).toBeNumber()
    })
  }, 30_000)

  test("a child's prompt written in the gap before its stamp is covered by that stamp", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      // Runs straight after the parent's stamp, before the walk reaches the
      // child: a launch whose prompt landed in that gap.
      const remove = Owed.removeSession
      const written: MessageV2.User[] = []
      Owed.removeSession = async (sessionID: string) => {
        if (sessionID === parent.id) {
          await tick()
          written.push((await user(sub.id, "count")) as MessageV2.User)
        }
        return remove(sessionID)
      }
      try {
        await Session.stop({ sessionID: parent.id })
      } finally {
        Owed.removeSession = remove
      }

      const stopped = await Session.get(sub.id)
      expect(written.length).toBe(1)
      expect(stopped.time.stopped).toBeGreaterThanOrEqual(written[0].time.created)
      expect(Recovery.owed(stopped, (await Messages.reader()).prompted(sub.id))).toBe(false)
    })
  }, 30_000)
})

describe("Recovery.subagents", () => {
  test("reports running, completed, and stopped from the database alone", async () => {
    await withProject(async () => {
      const parent = await root()
      const running = await child(parent.id)
      await user(running.id, "a")
      const done = await child(parent.id)
      const prompt = await user(done.id, "b")
      await assistant(done.id, prompt.id, "B")
      const delivered = Date.now() + 1
      await Session.update(done.id, (draft) => void (draft.time.injected = delivered))
      const stopped = await child(parent.id)
      await user(stopped.id, "c")
      await Session.stop({ sessionID: stopped.id })
      const fresh = await child(parent.id)

      const list = await Recovery.subagents(parent.id)
      expect(Object.fromEntries(list.map((s) => [s.id, s.status]))).toEqual({
        [running.id]: "running",
        [done.id]: "completed",
        [stopped.id]: "stopped",
        [fresh.id]: "running",
      })
      expect(list.find((s) => s.id === done.id)).toEqual({
        id: done.id,
        parentSessionID: parent.id,
        status: "completed",
        description: "count files",
        agent: "build",
        time: { created: prompt.time.created, completed: delivered },
      })
      expect(list.find((s) => s.id === running.id)?.progress).toEqual({ toolCount: 0, currentActivity: undefined })
      expect(list.find((s) => s.id === stopped.id)?.time.completed).toBe((await Session.get(stopped.id)).time.stopped!)
    })
  }, 30_000)

  test("shows what was reported, not how the child's last turn ended", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      const prompt = await user(sub.id, "count")
      const reply = (await assistant(sub.id, prompt.id, "partial")) as MessageV2.Assistant
      await Session.updateMessage({ ...reply, error: { name: "MessageAbortedError", data: { message: "aborted" } } })

      await Recovery.fail(sub.id, "gave up after 3 wakes", prompt.time.created)

      expect((await results(parent.id)).map((r) => r.status)).toEqual(["failed"])
      expect((await Session.get(sub.id)).time.reported).toBe("failed")
      expect((await Recovery.subagents(parent.id)).map((s) => s.status)).toEqual(["failed"])
    })
  }, 30_000)

  test("a parent stopped after its child reported keeps the report and its time", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      const prompt = await user(sub.id, "count")
      await Recovery.fail(sub.id, "model unavailable", prompt.time.created)
      const delivered = (await Session.get(sub.id)).time.injected
      await tick()

      await Session.stop({ sessionID: parent.id })

      expect((await Session.get(sub.id)).time.stopped).toBeGreaterThan(delivered!)
      expect((await Recovery.subagents(parent.id)).map((s) => [s.status, s.time.completed])).toEqual([
        ["failed", delivered],
      ])
    })
  }, 30_000)
})
