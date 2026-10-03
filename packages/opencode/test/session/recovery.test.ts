import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { Recovery } from "../../src/session/recovery"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Db } from "../../src/storage/db"
import { Meta } from "../../src/storage/meta"
import { Debt } from "../../src/storage/debt"
import { Sessions } from "../../src/storage/sessions"
import { BackgroundJob } from "../../src/background/job"
import { BackgroundDeliver } from "../../src/background/deliver"
import { BackgroundProcess } from "../../src/background/process"
import { SessionBusy } from "../../src/session/busy"
import { SessionPrompt } from "../../src/session/prompt"
import { Messages } from "../../src/storage/messages"
import { MessageV2 } from "../../src/session/message-v2"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { Provider } from "../../src/provider/provider"

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
  for (const id of ids) {
    await Sessions.update(id, (draft) => {
      draft.time.stopped = Date.now() + 60_000
      draft.turn = undefined
    }).catch(() => {})
    await Debt.drop(id)
  }
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

async function child(parentID: string, allowedTools?: Session.AllowedTool[]) {
  const created = await Session.create({ parentID, title: "count files (@general subagent)" })
  made.push(created.id)
  await Debt.add(created.id, "subagent", parentID)
  return Session.update(created.id, (draft) => {
    draft.current = { agent: "build", model }
    if (allowedTools) draft.allowedTools = allowedTools
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
    m.parts.flatMap((p) => (p.type === "text" && !p.internal ? [p.text] : [])),
  )
}

// A job record owned by `sessionID`, finished unless `status` says otherwise,
// with its debt.
async function job(id: string, sessionID: string, status: BackgroundJob.Status = "exited") {
  await BackgroundJob.write({
    id,
    sessionID,
    directory: Instance.directory,
    project: Instance.directory,
    command: "echo hi",
    description: "say hi",
    status,
    ...(status === "running" ? {} : { exit: 0 }),
    time: {
      created: Date.now() - 1000,
      hard: Date.now() + 60_000,
      ...(status === "running" ? {} : { completed: Date.now() }),
    },
  })
  await Debt.add(id, "job", sessionID)
}

async function drop(id: string) {
  await Debt.remove(id)
  await BackgroundJob.remove(id)
}

async function jobs(sessionID: string) {
  return (await Session.messages({ sessionID }))
    .flatMap((m) => m.parts)
    .flatMap((p) => (p.type === "text" && p.backgroundJobResult ? [p.backgroundJobResult] : []))
}

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
        edits: true,
      })
      expect(part.type === "text" && part.text).toContain("There are 7 files.")
      expect(await Debt.has(sub.id)).toBe(false)
      expect(state.requests.length).toBe(1)
    })
  }, 30_000)

  // A child's tool access, not any launch's toolset, decides whether its result
  // is edits to review or a review; the entries may be ids or path-scoped objects.
  for (const [name, tools, edits] of [
    ["read-only ids and objects", ["read", "grep", { id: "read", paths: ["/x"] }], false],
    ["a path-scoped edit object", ["read", { id: "edit", paths: ["/x/*"] }], true],
    ["an apply_patch id", ["read", "apply_patch"], true],
  ] as const) {
    test(`a delivered result records edits=${edits} for ${name}`, async () => {
      await withProject(async () => {
        const parent = await root()
        const sub = await child(parent.id, [...tools] as Session.AllowedTool[])
        const prompt = await user(sub.id, "count the files")
        await tick()
        await assistant(sub.id, prompt.id, "There are 7 files.")
        state.replies.push("Noted.")

        await settle()
        await settle()

        expect((await results(parent.id)).map((r) => [r.subagentId, r.status, r.edits])).toEqual([
          [sub.id, "completed", edits],
        ])
      })
    }, 30_000)
  }

  test("a delivered result carries the fingerprint its child was last asked at", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id, ["read"])
      await Session.update(sub.id, (draft) => void (draft.asked = "fingerprint-at-ask"))
      const prompt = await user(sub.id, "review the diff")
      await tick()
      await assistant(sub.id, prompt.id, "0 findings")
      state.replies.push("Noted.")

      await settle()
      await settle()

      expect((await results(parent.id)).map((r) => [r.subagentId, r.edits, r.tree])).toEqual([
        [sub.id, false, "fingerprint-at-ask"],
      ])
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

  test("done needs no turn, nothing owed, nothing waiting, and a last turn not interrupted", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      const prompt = await user(sub.id, "count the files")
      await tick()
      const first = await assistant(sub.id, prompt.id, "first answer")
      expect(await Recovery.done(await Session.get(sub.id))).toBe(true)

      await job("job_done_rule", sub.id)
      try {
        expect(await Recovery.done(await Session.get(sub.id))).toBe(false)
      } finally {
        await drop("job_done_rule")
      }

      const waiting = await user(sub.id, "a job finished", true)
      expect(await Recovery.done(await Session.get(sub.id))).toBe(false)
      await tick()
      const cut = await assistant(sub.id, waiting.id, "half", undefined)
      await Session.updateMessage({
        ...cut,
        time: { ...cut.time, completed: Date.now() },
        error: { name: "MessageAbortedError", data: { message: "aborted" } },
      } as typeof cut)
      expect(await Recovery.done(await Session.get(sub.id))).toBe(false)
      expect(first.id < cut.id).toBe(true)
    })
  }, 30_000)

  test("an interrupted child keeps its debt and reports once a new message runs it to an end", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      const prompt = await user(sub.id, "count the files")
      await tick()
      const cut = await assistant(sub.id, prompt.id, "half", undefined)
      await Session.updateMessage({
        ...cut,
        time: { ...cut.time, completed: Date.now() },
        error: { name: "MessageAbortedError", data: { message: "aborted" } },
      } as typeof cut)
      await Session.interrupt(sub.id)

      await settle({ idle: true })
      expect(await results(parent.id)).toEqual([])
      expect(await Debt.has(sub.id)).toBe(true)
      expect((await Recovery.subagents(parent.id)).map((s) => s.status)).toEqual(["interrupted"])

      state.replies.push("Now 9 files.", "ok")
      await SessionPrompt.prompt({
        model: Provider.INHERIT,
        variant: Provider.INHERIT,
        sessionID: sub.id,
        parts: [{ type: "text", text: "go on" }],
      })
      await settle()

      expect((await results(parent.id)).map((r) => r.status)).toEqual(["completed"])
      expect(await Debt.has(sub.id)).toBe(false)
    })
  }, 30_000)

  test("stopping a child whose parent is live tells the parent it was stopped", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      const prompt = await user(sub.id, "count the files")
      await tick()
      await assistant(sub.id, prompt.id, "partial")
      state.replies.push("ok")
      await Session.stop({ sessionID: sub.id })

      await settle()

      expect((await results(parent.id)).map((r) => r.status)).toEqual(["cancelled"])
      expect(await Debt.has(sub.id)).toBe(false)
      expect((await Recovery.subagents(parent.id)).map((s) => s.status)).toEqual(["stopped"])
    })
  }, 30_000)

  test("stopping the parent pays every debt it is owed without starting its turn", async () => {
    await withProject(async () => {
      const parent = await root()
      await user(parent.id, "start")
      const sub = await child(parent.id)
      const prompt = await user(sub.id, "count the files")
      await tick()
      await assistant(sub.id, prompt.id, "partial")
      await job("job_under_stop", parent.id)
      try {
        await Session.stop({ sessionID: parent.id })
        await settle({ idle: true })

        expect((await results(parent.id)).map((r) => r.status)).toEqual(["cancelled"])
        expect((await jobs(parent.id)).map((j) => j.jobId)).toEqual(["job_under_stop"])
        expect(await Recovery.debts(parent.id)).toEqual([])
        expect((await Recovery.subagents(parent.id)).map((s) => s.status)).toEqual(["stopped"])
        expect((await Sessions.listUnanswered()).map((s) => s.id).filter((id) => made.includes(id))).toEqual([])
        expect(state.requests.length).toBe(0)

        // A message sent afterwards starts a turn that reads both notices.
        state.replies.push("back", "back")
        await SessionPrompt.prompt({
          model: Provider.DEFAULT,
          variant: Provider.DEFAULT,
          sessionID: parent.id,
          parts: [{ type: "text", text: "carry on" }],
        })
        await settle()

        const sent = (state.requests as { messages: unknown[] }[]).map((r) => JSON.stringify(r.messages))
        const turn = sent.filter((body) => body.includes("<background-job-result>"))
        expect(turn.length).toBe(1)
        expect(turn[0].split("<background-subagent-result>").length).toBe(2)
        expect(turn[0]).toContain("carry on")
      } finally {
        await drop("job_under_stop")
      }
    })
  }, 30_000)

  test("a settled job's result is delivered into its session once, paying the debt", async () => {
    await withProject(async () => {
      const session = await root()
      await user(session.id, "run it")
      await job("job_settled_1", session.id)
      state.replies.push("Got it.")

      try {
        await settle()
        await settle()

        expect((await jobs(session.id)).map((j) => j.jobId)).toEqual(["job_settled_1"])
        expect(await Debt.owing(session.id)).toBe(false)
        expect(state.requests.length).toBe(1)
      } finally {
        await drop("job_settled_1")
      }
    })
  }, 30_000)

  test("a delivered job result runs at the session's current variant, not the model's default", async () => {
    await withProject(async () => {
      const session = await root()
      await user(session.id, "run it")
      await Session.update(session.id, (draft) => void (draft.current = { agent: "build", model, variant: "high" }))
      await job("job_variant_1", session.id)
      state.replies.push("Got it.")

      try {
        await settle()

        const delivered = (await Session.messages({ sessionID: session.id })).find((m) =>
          m.parts.some((p) => p.type === "text" && p.backgroundJobResult?.jobId === "job_variant_1"),
        )
        expect(delivered?.info.role === "user" && delivered.info.variant).toBe("high")
        expect(delivered?.info.role === "user" && delivered.info.model).toEqual(model)
      } finally {
        await drop("job_variant_1")
      }
    })
  }, 30_000)

  test("a running job a Stop kills is reported as stopped at once, without starting a turn", async () => {
    await withProject(async () => {
      const session = await root()
      await user(session.id, "run it")
      const proc = Bun.spawn({ cmd: ["sleep", "30"], detached: true, stdio: ["ignore", "ignore", "ignore"] })
      await job("job_killed_by_stop", session.id, "running")
      const live = (await BackgroundProcess.inspect(proc.pid))!
      await BackgroundJob.update(
        "job_killed_by_stop",
        (draft) => void (draft.process = { pid: live.pid, start: live.start, pgid: live.pgid }),
      )
      try {
        await Session.stop({ sessionID: session.id })
        await settle({ idle: true })

        expect((await BackgroundJob.get("job_killed_by_stop"))?.ended).toBe("stop")
        expect((await jobs(session.id)).map((j) => j.status)).toEqual(["stopped"])
        expect(await Debt.has("job_killed_by_stop")).toBe(false)
        expect(state.requests.length).toBe(0)
      } finally {
        proc.kill()
        await drop("job_killed_by_stop")
      }
    })
  }, 30_000)

  test("a job left running by an interrupt (Esc) still delivers its result", async () => {
    await withProject(async () => {
      const session = await root()
      await user(session.id, "run it")
      await Session.interrupt(session.id)
      state.replies.push("Got it.")
      await job("job_after_interrupt", session.id)

      try {
        await settle()

        expect((await jobs(session.id)).map((j) => j.jobId)).toEqual(["job_after_interrupt"])
        expect(await Debt.owing(session.id)).toBe(false)
      } finally {
        await drop("job_after_interrupt")
      }
    })
  }, 30_000)

  test("a job still running at an Esc delivers and wakes once it exits", async () => {
    await withProject(async () => {
      const session = await root()
      await user(session.id, "run it")
      await job("job_through_interrupt", session.id, "running")
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

        expect((await jobs(session.id)).map((j) => j.jobId)).toEqual(["job_through_interrupt"])
        expect(await texts(session.id)).toContain("Got it.")
        expect(await Debt.owing(session.id)).toBe(false)
      } finally {
        await drop("job_through_interrupt")
      }
    })
  }, 30_000)

  test("a delivery after a same-millisecond stop sorts after it, and a later-dated stop never dates it ahead", async () => {
    await withProject(async () => {
      const tied = await root()
      await user(tied.id, "a")
      const now = Date.now()
      await Session.update(tied.id, (draft) => void (draft.time.stopped = now))
      const id = "job_time_bound"
      await Debt.add(id, "job", tied.id)
      try {
        const claim = await Debt.claimer()
        const tie = await SessionPrompt.deliver({
          model: Provider.DEFAULT,
          variant: Provider.DEFAULT,
          sessionID: tied.id,
          parts: [{ type: "text", text: "tied", synthetic: true }],
          wake: false,
          claim: () => claim.pay(id),
        })
        expect(tie!.info.time.created).toBeGreaterThan(now)

        const ahead = await root()
        await user(ahead.id, "b")
        await Session.update(ahead.id, (draft) => void (draft.time.stopped = Date.now() + 10_000))
        const before = Date.now()
        const bounded = (await SessionPrompt.deliver({
          model: Provider.INHERIT,
          variant: Provider.INHERIT,
          sessionID: ahead.id,
          parts: [{ type: "text", text: "ahead", synthetic: true }],
          wake: false,
        }))!.info
        const after = Date.now()
        expect(bounded.time.created).toBeGreaterThan(before)
        expect(bounded.time.created).toBeLessThanOrEqual(after + 1)
        // A reply written once the clock has passed the delivery sorts after
        // it; the bound is what makes that wait at most a millisecond.
        while (Date.now() <= bounded.time.created) await Bun.sleep(1)
        const later = await user(ahead.id, "c")
        const order = (await Session.messages({ sessionID: ahead.id })).map((m) => m.info.id)
        expect(order.indexOf(later.id)).toBeGreaterThan(order.indexOf(bounded.id))
      } finally {
        await Debt.remove(id)
      }
    })
  }, 30_000)

  test("a debt whose caller is gone is dropped", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      const prompt = await user(sub.id, "count")
      await tick()
      await assistant(sub.id, prompt.id, "7")
      await Sessions.remove(parent.id)

      await settle({ idle: true })

      expect(await Debt.has(sub.id)).toBe(false)
    })
  }, 30_000)

  test("the delivery transaction writes nothing when the claim is lost", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      await user(sub.id, "x")
      await Debt.remove(sub.id)
      const delivered = await Recovery.deliver(parent.id, [{ text: "r", synthetic: true }], sub.id)
      expect(delivered).toBe(false)
      expect(await Session.messages({ sessionID: parent.id })).toEqual([])
    })
  }, 30_000)

  test("a delivery that fails after writing its message rolls back the message and the payment", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      await user(sub.id, "x")
      // Serializing the part throws inside the transaction, after the message
      // row has already been written.
      const broken = { text: "r", synthetic: true, metadata: { size: 1n } } as unknown as Recovery.Part

      await expect(Recovery.deliver(parent.id, [broken], sub.id)).rejects.toThrow(
        "JSON.stringify cannot serialize BigInt.",
      )

      expect(await Session.messages({ sessionID: parent.id })).toEqual([])
      expect(await Debt.has(sub.id)).toBe(true)
    })
  }, 30_000)

  test("a lost-claim opener lets a prompt that joined it resolve and answer", async () => {
    await withProject(async () => {
      const session = await root()
      await user(session.id, "start")
      state.replies.push("answered")
      const gate = Promise.withResolvers<void>()
      const opener = SessionPrompt.deliver({
        model: Provider.DEFAULT,
        variant: Provider.DEFAULT,
        sessionID: session.id,
        parts: [{ type: "text", text: "paid elsewhere", synthetic: true }],
        claim: () => false,
      })
      const joiner = gate.promise.then(() =>
        SessionPrompt.prompt({
          model: Provider.INHERIT,
          variant: Provider.INHERIT,
          sessionID: session.id,
          parts: [{ type: "text", text: "typed" }],
        }),
      )
      gate.resolve()

      expect(await opener).toBeUndefined()
      const answer = await Promise.race([joiner, Bun.sleep(10_000).then(() => "hung" as const)])
      expect(answer === "hung" ? "hung" : answer.info.role).toBe("assistant")
    })
  }, 30_000)
})

describe("Recovery.debts", () => {
  test("lists what a caller is owed, with live state, and nothing once paid", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      const prompt = await user(sub.id, "count")
      await job("job_listed", parent.id, "running")
      try {
        const listed = await Recovery.debts(parent.id)
        const byID = new Map(listed.map((d) => [d.responder, d]))
        expect(byID.get("job_listed")).toMatchObject({
          kind: "job",
          state: "running",
          description: "say hi",
          command: "echo hi",
        })
        expect(byID.get(sub.id)).toMatchObject({
          kind: "subagent",
          state: "running",
          description: "count files",
        })
        expect(listed.length).toBe(2)

        await tick()
        await assistant(sub.id, prompt.id, "7")
        await Debt.remove(sub.id)
        expect((await Recovery.debts(parent.id)).map((d) => d.responder)).toEqual(["job_listed"])
      } finally {
        await drop("job_listed")
      }
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

      expect(await texts(cut.id)).toEqual(["do the thing", Recovery.resumeText(0), "Resumed."])
      expect((await Session.get(cut.id)).turn).toBeUndefined()
      expect((await Session.get(stopped.id)).turn).toBeUndefined()
      expect(await texts(stopped.id)).toEqual(["other thing"])
      expect(state.requests.length).toBe(1)
    })
  }, 30_000)

  // A cut turn whose last step was waiting on a question: the assistant
  // message is unfinished and holds the question as a running tool part.
  const questions = [
    {
      question: "Which one?",
      header: "Pick",
      options: [
        { label: "A", description: "first" },
        { label: "B", description: "second" },
      ],
    },
  ]
  const cutOff =
    "[Your question tool call, not answered: the turn was cut off. Only the question tool shows the user a picker, so keep using it for your next question.]\nHeader: Pick\nYou asked: Which one?\nOptions (pick one):\n- A — first\n- B — second"

  async function asking(sessionID: string) {
    const opener = await user(sessionID, "ask me")
    const info = await assistant(sessionID, opener.id, "Let me ask.", undefined)
    const part = await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: info.id,
      sessionID,
      type: "tool",
      callID: "toolu_q",
      tool: "question",
      state: { status: "running", input: { questions }, time: { start: Date.now() }, metadata: { plain: true } },
    })
    await Session.mark(sessionID, (draft) => void (draft.turn = { at: Date.now() - 10, pid: DEAD }))
    return part
  }

  test("a question a cut turn was waiting on is written down as unanswered before the resume", async () => {
    await withProject(async () => {
      const cut = await root()
      const part = await asking(cut.id)
      state.replies.push("Resumed.")

      await settle()

      expect(await texts(cut.id)).toEqual(["ask me", "Let me ask.", "", cutOff, Recovery.resumeText(0), "Resumed."])
      const messages = await Session.messages({ sessionID: cut.id })
      const replaced = messages.flatMap((m) => m.parts).find((p) => p.id === part.id)
      expect(replaced).toMatchObject({
        type: "text",
        synthetic: true,
        question: { callID: "toolu_q", questions, error: "the turn was cut off" },
      })
      const note = messages[2]
      expect(note.info.role).toBe("user")
      expect(note.info.role === "user" && note.info.synthetic).toBeFalsy()
      expect(JSON.stringify(state.requests)).not.toContain("toolu_q")
      expect(state.requests.length).toBe(1)
    })
  }, 30_000)

  test("a stopped cut turn's question is written down, stamped past by the stop, and nothing resumes", async () => {
    await withProject(async () => {
      const cut = await root()
      await asking(cut.id)
      await Session.update(cut.id, (draft) => void (draft.time.stopped = Date.now()))

      await settle({ idle: true })

      expect(await texts(cut.id)).toEqual(["ask me", "Let me ask.", "", cutOff])
      const note = (await Session.messages({ sessionID: cut.id })).at(-1)!
      const session = await Session.get(cut.id)
      expect(session.turn).toBeUndefined()
      expect(session.time.stopped).toBeGreaterThanOrEqual(note.info.time.created)
      expect((await Sessions.listUnanswered(Date.now())).map((s) => s.id)).not.toContain(cut.id)
      expect(state.requests.length).toBe(0)
    })
  }, 30_000)

  test("a cut question behind a later message is closed in place, and its note still reads before that message", async () => {
    await withProject(async () => {
      const cut = await root()
      const part = await asking(cut.id)
      await user(cut.id, "a job result arrived")
      state.replies.push("Resumed.")

      await settle()

      const stored = (await Session.messages({ sessionID: cut.id }))
        .flatMap((m) => m.parts)
        .find((p) => p.id === part.id)
      expect(stored).toMatchObject({
        type: "tool",
        state: { status: "error", error: "the turn was cut off", metadata: { plain: true } },
      })
      expect(await texts(cut.id)).toEqual([
        "ask me",
        "Let me ask.",
        "a job result arrived",
        Recovery.resumeText(0),
        "Resumed.",
      ])
      const sent = JSON.stringify(state.requests[0])
      const note = sent.indexOf(JSON.stringify(cutOff).slice(1, -1))
      expect(note).toBeGreaterThan(-1)
      expect(note).toBeLessThan(sent.indexOf("a job result arrived"))
      expect(sent).not.toContain("toolu_q")
    })
  }, 30_000)

  // The pass opens the session's instance between reading the marker and
  // resuming, so a directory whose bootstrap waits on a plugin holds the pass
  // in that window while the test writes a fact the pass has not seen.
  async function held(write: (sessionID: string) => Promise<unknown>) {
    const hold = globalThis as { recoveryEntered?: () => void; recoveryHold?: Promise<void> }
    await using dir = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "hold.ts"),
          `export default async () => {
            globalThis.recoveryEntered?.()
            await globalThis.recoveryHold
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
    const session = await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const created = await root()
        await user(created.id, "do the thing")
        await Session.mark(created.id, (draft) => void (draft.turn = { at: Date.now() - 10, pid: DEAD }))
        await Instance.dispose()
        return created
      },
    })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    hold.recoveryEntered = entered.resolve
    hold.recoveryHold = release.promise
    try {
      const pass = Recovery.poke()
      await entered.promise
      await write(session.id)
      release.resolve()
      await pass
      // The pass does not await the resume's send, whose lost claim is what
      // clears the marker this process claimed; a new turn's marker is not it.
      const settled = async () => {
        const turn = (await Sessions.read(session.id)).turn
        return turn?.pid !== process.pid || turn.nonce === "fresh"
      }
      await until(settled, "the resume to settle")
      return {
        turn: (await Sessions.read(session.id)).turn,
        texts: await Instance.provide({ directory: dir.path, fn: () => texts(session.id) }),
      }
    } finally {
      release.resolve()
      hold.recoveryEntered = undefined
      hold.recoveryHold = undefined
    }
  }

  test("a stop stamped after the pass read the marker wins: no resume, and the marker is cleared", async () => {
    const outcome = await held((id) => Sessions.update(id, (draft) => void (draft.time.stopped = Date.now())))

    expect(outcome.turn).toBeUndefined()
    expect(outcome.texts).toEqual(["do the thing"])
    expect(state.requests.length).toBe(0)
  }, 30_000)

  test("a marker a new turn replaced after the pass read it is left alone", async () => {
    const fresh = { at: Date.now() + 1000, pid: process.pid, boot: Recovery.boot, nonce: "fresh" }
    const outcome = await held((id) => Sessions.update(id, (draft) => void (draft.turn = fresh)))

    expect(outcome.turn).toEqual(fresh)
    expect(outcome.texts).toEqual(["do the thing"])
    expect(state.requests.length).toBe(0)
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

  test("a cut child whose job finished across the restart answers once and reports that answer", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      const prompt = await user(sub.id, "count")
      await assistant(sub.id, prompt.id, "", "tool-calls")
      await Session.mark(sub.id, (draft) => void (draft.turn = { at: Date.now(), pid: DEAD }))
      await job("job_across_restart", sub.id)
      // The child's answer, then the parent's reply to the result.
      state.replies.push("7 files", "noted")

      try {
        await settle()

        // Every request ends on what the model has yet to answer.
        for (const request of state.requests as { messages: { role: string }[] }[])
          expect(request.messages.at(-1)?.role).toBe("user")
        expect(state.requests.length).toBe(2)
        expect((await results(parent.id)).map((r) => r.status)).toEqual(["completed"])
        expect((await texts(parent.id)).some((t) => t.includes("7 files"))).toBe(true)
      } finally {
        await drop("job_across_restart")
      }
    })
  }, 30_000)

  test("a message written while a step was starting is answered next, not sent ahead of the reply", async () => {
    await withProject(async () => {
      const session = await root()
      const prompt = await user(session.id, "count")
      const landed = await user(session.id, "job done", true)
      // Written after the step read the history, but minted before its reply.
      await user(session.id, "continue", true)
      await assistant(session.id, landed.id, "7 files")
      state.replies.push("carrying on")

      await SessionPrompt.wake(session.id)

      expect(prompt.id < landed.id).toBe(true)
      const sent = state.requests as { messages: { role: string; content: unknown }[] }[]
      expect(sent.length).toBe(1)
      expect(sent[0].messages.at(-1)?.role).toBe("user")
      expect(JSON.stringify(sent[0].messages.at(-1)?.content)).toContain("continue")
    })
  }, 30_000)

  test("gives up after the cap, delivering a failed result for an owed child", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      await user(sub.id, "count")
      await Session.mark(sub.id, (draft) => void (draft.turn = { at: Date.now(), pid: DEAD, resumes: Recovery.CAP }))
      state.replies.push("ok")
      const before = Date.now()

      await settle()

      expect((await results(parent.id)).map((r) => r.status)).toEqual(["failed"])
      const given = await Session.get(sub.id)
      expect(given.turn).toBeUndefined()
      expect(given.time.stopped).toBeGreaterThanOrEqual(before)
    })
  }, 30_000)

  test("a root that gives up is only unmarked, so a later job result still wakes it", async () => {
    await withProject(async () => {
      const session = await root()
      await user(session.id, "do the thing")
      await Session.mark(
        session.id,
        (draft) => void (draft.turn = { at: Date.now(), pid: DEAD, resumes: Recovery.CAP }),
      )

      await settle({ idle: true })

      const given = await Session.get(session.id)
      expect(given.turn).toBeUndefined()
      expect(given.time.stopped).toBeUndefined()
      expect(await texts(session.id)).toEqual(["do the thing"])

      await job("job_after_give_up", session.id)
      state.replies.push("Got it.")
      try {
        await settle()

        expect((await jobs(session.id)).map((j) => j.jobId)).toEqual(["job_after_give_up"])
        expect((await texts(session.id)).at(-1)).toBe("Got it.")
        expect(await Debt.owing(session.id)).toBe(false)
      } finally {
        await drop("job_after_give_up")
      }
    })
  }, 30_000)

  test("giving up waits for a job the cut turn started, whose result reports instead", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      await user(sub.id, "count")
      await Session.mark(sub.id, (draft) => void (draft.turn = { at: Date.now(), pid: DEAD, resumes: Recovery.CAP }))
      const record = {
        id: "job_from_cut_child",
        sessionID: sub.id,
        directory: Instance.directory,
        project: Instance.directory,
        command: "sleep 1",
        description: "wait",
        status: "running" as const,
        // Launched by this process, so no pass here settles or reaps it.
        launcher: { pid: process.pid, boot: Recovery.boot },
        time: { created: Date.now(), hard: Date.now() + 60_000 },
      }
      await BackgroundJob.write(record)
      await Debt.add(record.id, "job", sub.id)

      try {
        await settle({ idle: true })
        expect(await results(parent.id)).toEqual([])
        expect((await Session.get(sub.id)).turn).toBeUndefined()

        await BackgroundJob.write({
          ...record,
          status: "exited",
          exit: 0,
          time: { ...record.time, completed: Date.now() },
        })
        state.replies.push("counted 7", "noted")
        await settle()

        expect((await results(parent.id)).map((r) => r.status)).toEqual(["completed"])
      } finally {
        await drop(record.id)
      }
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
      const unanswered = (await Sessions.listUnanswered()).map((s) => s.id)
      expect(unanswered.includes(typed.id)).toBe(false)
      expect(unanswered.includes(stopped.id)).toBe(false)
    })
  }, 30_000)

  test("a subagent that owes nothing is not woken for a message waiting in it", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      await Debt.remove(sub.id)
      await Session.updateMessage({
        id: Identifier.ascending("message"),
        sessionID: sub.id,
        role: "user",
        time: { created: Date.now() - 20_000 },
        agent: "build",
        model,
        synthetic: true,
      })

      await settle({ idle: true })

      expect(state.requests.length).toBe(0)
    })
  }, 30_000)
})

describe("Recovery launch failures", () => {
  test("a child whose turn could not run reports failed once, and one with no debt reports nothing", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      const prompt = await user(sub.id, "count")
      state.replies.push("ok")

      await Recovery.fail(sub.id, "model unavailable", prompt.time.created)
      await Recovery.fail(sub.id, "model unavailable", prompt.time.created)
      await settle()

      expect((await results(parent.id)).map((r) => r.status)).toEqual(["failed"])
      expect((await texts(parent.id)).some((t) => t.includes("ERROR: model unavailable"))).toBe(true)
      expect((await Recovery.subagents(parent.id)).map((s) => s.status)).toEqual(["failed"])
    })
  }, 30_000)

  test("a failure after an Esc is the person's, so it reports nothing", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      const prompt = await user(sub.id, "count")
      await tick()
      await Session.interrupt(sub.id)

      await Recovery.fail(sub.id, "aborted", prompt.time.created)

      expect(await results(parent.id)).toEqual([])
      expect(await Debt.has(sub.id)).toBe(true)
    })
  }, 30_000)
})

describe("Recovery job strikes", () => {
  test("a job whose delivery throws keeps its debt after every retry", async () => {
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
      await Debt.add("job_throws", "job", session.id)

      try {
        for (let pass = 0; pass < 5; pass++) await Recovery.poke()

        expect(await Debt.has("job_throws")).toBe(true)
        expect(await jobs(session.id)).toEqual([])
      } finally {
        await drop("job_throws")
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
  test("stamps the whole subtree before any turn in it ends", async () => {
    await withProject(async () => {
      const parent = await root()
      const sub = await child(parent.id)
      const grandchild = await child(sub.id)
      const ids = [parent.id, sub.id, grandchild.id]
      // Every model call waits here, so each session's turn is live at the stop.
      const gate = Promise.withResolvers<void>()
      state.holds.push(...ids.flatMap(() => [gate.promise, gate.promise]))
      const turns = ids.map((id) =>
        SessionPrompt.prompt({
          model: Provider.DEFAULT,
          variant: Provider.DEFAULT,
          sessionID: id,
          parts: [{ type: "text", text: "go" }],
        }).catch(() => undefined),
      )
      await until(() => ids.every((id) => SessionBusy.busy(id)), "every turn to start")
      // A turn's end is observed where the cancel that aborts it ends it, and
      // the stamps are read straight from the database at that moment.
      const read = await Sessions.reader()
      const before = Date.now()
      const stamped = (id: string) => (read(id)?.time.stopped ?? 0) >= before
      const seen: { id: string; subtree: boolean }[] = []
      const unsubscribe = SessionBusy.onIdle((sessionID) => {
        if (!ids.includes(sessionID)) return
        seen.push({ id: sessionID, subtree: ids.every(stamped) })
      })
      try {
        await Session.stop({ sessionID: parent.id })
      } finally {
        unsubscribe()
        gate.resolve()
      }
      await Promise.all(turns)

      const stamps = (await Promise.all([parent, sub, grandchild].map((s) => Session.get(s.id)))).map(
        (s) => s.time.stopped!,
      )
      expect(seen.map((entry) => entry.id).toSorted()).toEqual(ids.toSorted())
      expect(seen.map((entry) => entry.subtree)).toEqual([true, true, true])
      expect(stamps.every((t) => t >= before)).toBe(true)
    })
  }, 30_000)

  test("an Esc stamps the turn stopped and leaves what the session is owed", async () => {
    await withProject(async () => {
      const session = await root()
      await user(session.id, "go")
      const sub = await child(session.id)
      await user(sub.id, "count")

      await Session.interrupt(session.id)

      expect((await Session.get(session.id)).time.stopped).toBeNumber()
      expect(await Debt.has(sub.id)).toBe(true)
      expect((await Recovery.subagents(session.id)).map((s) => s.status)).toEqual(["running"])
    })
  }, 30_000)
})

describe("Recovery.subagents", () => {
  test("only an open debt makes a child live; one without shows what it delivered", async () => {
    await withProject(async () => {
      const parent = await root()
      const running = await child(parent.id)
      await user(running.id, "a")
      await Session.mark(
        running.id,
        (draft) => void (draft.turn = { at: Date.now(), pid: process.pid, boot: Recovery.boot }),
      )
      const interrupted = await child(parent.id)
      const asked = await user(interrupted.id, "b")
      const cut = (await assistant(interrupted.id, asked.id, "partial")) as MessageV2.Assistant
      await Session.updateMessage({ ...cut, error: { name: "MessageAbortedError", data: { message: "aborted" } } })
      const unpaid = await child(parent.id)
      const counted = await user(unpaid.id, "c")
      await assistant(unpaid.id, counted.id, "C")
      const done = await child(parent.id)
      const prompt = await user(done.id, "d")
      await assistant(done.id, prompt.id, "D")
      const statuses = async () =>
        Object.fromEntries((await Recovery.subagents(parent.id)).map((s) => [s.id, s.status]))

      // Nothing has paid yet: both finished children are owed and unpaid.
      expect(await statuses()).toEqual({
        [running.id]: "running",
        [interrupted.id]: "interrupted",
        [unpaid.id]: "unpaid",
        [done.id]: "unpaid",
      })

      state.replies.push("ok")
      await Recovery.collect(done.id)
      await settle({ idle: true })

      const list = await Recovery.subagents(parent.id)
      expect(await statuses()).toEqual({
        [running.id]: "running",
        [interrupted.id]: "interrupted",
        [unpaid.id]: "completed",
        [done.id]: "completed",
      })
      expect(list.find((s) => s.id === running.id)?.progress).toEqual({ toolCount: 0, currentActivity: undefined })
      expect(list.find((s) => s.id === done.id)?.time.completed).toBeNumber()
      await Session.mark(running.id, (draft) => void (draft.turn = undefined))
    })
  }, 30_000)

  test("a child with no debt and no delivered result shows stopped, never running", async () => {
    await withProject(async () => {
      const parent = await root()
      // What a child in flight across the upgrade looks like: a prompt, maybe
      // a turn in progress, and no debt row, since the table started empty.
      const sub = await child(parent.id)
      await Debt.remove(sub.id)
      await user(sub.id, "count")

      const list = await Recovery.subagents(parent.id)

      expect(list.map((s) => s.status)).toEqual(["stopped"])
      expect(await Recovery.debts(parent.id)).toEqual([])
    })
  }, 30_000)

  test("a child under a stopped parent shows stopped, its debt paid by the Stop", async () => {
    await withProject(async () => {
      const parent = await root()
      await user(parent.id, "go")
      const sub = await child(parent.id)
      await user(sub.id, "count")
      await Session.stop({ sessionID: parent.id })

      expect((await Recovery.subagents(parent.id)).map((s) => s.status)).toEqual(["stopped"])
      expect(await Recovery.debts(parent.id)).toEqual([])
      expect((await results(parent.id)).map((r) => r.status)).toEqual(["cancelled"])
    })
  }, 30_000)
})

describe("check-ins", () => {
  test("a check-in for a job that has since finished is dropped", async () => {
    await withProject(async () => {
      const session = await root()
      await user(session.id, "run it")
      await job("job_checkin_late", session.id)

      try {
        const record = (await BackgroundJob.get("job_checkin_late"))!
        expect(await BackgroundDeliver.checkin({ ...record, status: "running" })).toBe(false)
        expect(await texts(session.id)).toEqual(["run it"])
      } finally {
        await drop("job_checkin_late")
      }
    })
  }, 30_000)
})

describe("Recovery.init", () => {
  test("a live server opens the lease gate at once; any other waits out the grace", async () => {
    Recovery.stop()
    Recovery.init()
    await Bun.sleep(20)
    expect(await Recovery.lease()).toBe(false)
    Recovery.init({ live: true })
    await until(async () => (await Recovery.lease()) === true, "the live gate to open", 1_000)
  })
})
