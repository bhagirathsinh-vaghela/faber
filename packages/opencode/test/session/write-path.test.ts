import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { Recovery } from "../../src/session/recovery"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Debt } from "../../src/storage/debt"
import { Sessions } from "../../src/storage/sessions"
import { BackgroundJob } from "../../src/background/job"
import { SessionBusy } from "../../src/session/busy"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionPing } from "../../src/session/ping"
import { MessageV2 } from "../../src/session/message-v2"
import { AgentTool } from "../../src/tool/agent"
import { PlanEnterTool, PlanExitTool } from "../../src/tool/plan"
import { Agent } from "../../src/agent/agent"
import { Question } from "../../src/question"
import { Bus } from "../../src/bus"
import type { Tool } from "../../src/tool/tool"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { Provider } from "../../src/provider/provider"

Log.init({ print: false })

const MODEL = "claude-3-5-sonnet-20241022"
const model = { providerID: "anthropic", modelID: MODEL }

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  replies: [] as (string | (() => Response))[],
  requests: [] as { messages: unknown[]; system?: unknown; tools?: unknown }[],
  gate: undefined as Promise<void> | undefined,
}

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json()
      state.requests.push(body)
      const gate = body.tools ? state.gate : undefined
      if (gate) state.gate = undefined
      if (gate) await gate
      // A title request carries no tools and never takes a turn's reply.
      if (!body.tools) return reply("a title")
      const next = state.replies.shift() ?? "fallback"
      return typeof next === "string" ? reply(next) : next()
    },
  })
})

const made: string[] = []
const jobs: string[] = []

beforeEach(() => {
  state.replies.length = 0
  state.requests.length = 0
  state.gate = undefined
})

afterEach(async () => {
  for (const id of jobs.splice(0)) {
    await Debt.remove(id)
    await BackgroundJob.remove(id)
  }
  const ids = made.splice(0)
  for (const id of ids) {
    await Sessions.update(id, (draft) => {
      draft.time.stopped = Date.now() + 60_000
      draft.turn = undefined
    }).catch(() => {})
    await Debt.drop(id)
  }
  await until(() => ids.every((id) => !SessionBusy.busy(id)), "this test's turns to end")
})

afterAll(() => {
  state.server?.stop()
})

function sse(chunks: unknown[]) {
  const payload = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n") + "\n\n"
  return new Response(payload, { status: 200, headers: { "Content-Type": "text/event-stream" } })
}

// A step that ends in a tool call, so the turn runs a second step.
function toolCall() {
  return sse([
    {
      type: "message_start",
      message: {
        id: "msg-1",
        model: MODEL,
        usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: "no_such_tool", input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "{}" },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ])
}

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

// `plugin` is the source of a plugin module the project loads.
async function withProject(
  fn: () => Promise<void>,
  plugin?: string,
  extra: {
    agents?: string
    command?: Record<string, object>
    models?: Record<string, object>
    config?: Record<string, unknown>
  } = {},
) {
  await using project = await tmpdir({
    git: true,
    init: async (dir) => {
      if (plugin) await Bun.write(path.join(dir, "plugin.ts"), plugin)
      if (extra.agents) await Bun.write(path.join(dir, "AGENTS.md"), extra.agents)
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          enabled_providers: ["anthropic"],
          model: `anthropic/${MODEL}`,
          provider: {
            anthropic: {
              options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` },
              ...(extra.models ? { models: extra.models } : {}),
            },
          },
          ...(plugin ? { plugin: [`file://${path.join(dir, "plugin.ts")}`] } : {}),
          ...(extra.command ? { command: extra.command } : {}),
          ...extra.config,
        }),
      )
    },
  })
  await Instance.provide({ directory: project.path, fn })
}

async function root() {
  const created = await Session.create({})
  made.push(created.id)
  return created
}

async function child(parentID: string) {
  const created = await Session.create({ parentID, title: "count files (@general subagent)" })
  made.push(created.id)
  return Session.update(created.id, (draft) => void (draft.current = { agent: "build", model }))
}

// A person's message written without a turn, through the one entry.
async function typed(sessionID: string, text: string) {
  return SessionPrompt.prompt({
    variant: Provider.DEFAULT,
    sessionID,
    model,
    agent: "build",
    noReply: true,
    parts: [{ type: "text", text }],
  })
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

// A finished job owned by `sessionID`, with its debt.
async function job(id: string, sessionID: string) {
  jobs.push(id)
  await BackgroundJob.write({
    id,
    sessionID,
    directory: Instance.directory,
    project: Instance.directory,
    command: "echo hi",
    description: "say hi",
    status: "exited",
    exit: 0,
    time: { created: Date.now() - 1000, hard: Date.now() + 60_000, completed: Date.now() },
  })
  await Debt.add(id, "job", sessionID)
}

// A running job, so a check-in's claim holds.
async function running(id: string, sessionID: string) {
  jobs.push(id)
  await BackgroundJob.write({
    id,
    sessionID,
    directory: Instance.directory,
    project: Instance.directory,
    command: "sleep 100",
    description: "wait",
    status: "running",
    time: { created: Date.now() - 1000, hard: Date.now() + 60_000 },
  })
}

async function users(sessionID: string) {
  return (await Session.messages({ sessionID })).filter((m) => m.info.role === "user")
}

async function jobResults(sessionID: string) {
  return (await Session.messages({ sessionID }))
    .flatMap((m) => m.parts)
    .flatMap((p) => (p.type === "text" && p.backgroundJobResult ? [p.backgroundJobResult.jobId] : []))
}

async function tool(sessionID: string, messageID: string) {
  const info = await AgentTool.init()
  const toolset = Object.keys(await Agent.toolsets())[0]
  const ctx: Tool.Context = {
    sessionID,
    messageID,
    agent: "build",
    abort: new AbortController().signal,
    callID: "call_1",
    extra: { bypassAgentCheck: true },
    messages: [],
    metadata: () => {},
    ask: async () => {},
  }
  return (params: Partial<Parameters<typeof info.execute>[0]>) =>
    info.execute({ description: "count files", prompt: "count", subagent_type: "general", toolset, ...params }, ctx)
}

describe("loop-minted messages", () => {
  test("a compaction request, a check-in, a compaction nudge, and a plan switch never count as prompts", async () => {
    await withProject(async () => {
      const session = await root()
      const first = await typed(session.id, "hello")

      await SessionCompaction.create({ sessionID: session.id, agent: "build", auto: true })
      await running("job_checkin_1", session.id)
      await Recovery.notify(session.id, [{ text: "still running", synthetic: true }], "job_checkin_1")
      await SessionPrompt.deliver({
        model: Provider.DEFAULT,
        variant: Provider.DEFAULT,
        sessionID: session.id,
        parts: [{ type: "text", text: SessionCompaction.CONTINUE_NUDGE, synthetic: true }],
        join: true,
        wake: false,
      })
      const reply = await assistant(session.id, first.info.id, "")
      const switched = Bus.subscribe(Question.Event.Asked, (event) =>
        Question.reply({ requestID: event.properties.id, answers: [["Yes"]] }),
      )
      const plan = await PlanEnterTool.init()
      await plan.execute(
        {},
        {
          sessionID: session.id,
          messageID: reply.id,
          agent: "build",
          abort: new AbortController().signal,
          callID: "call_plan",
          extra: {},
          messages: [],
          metadata: () => {},
          ask: async () => {},
        },
      )
      switched()

      const minted = (await users(session.id)).slice(1)
      expect(minted.map((m) => m.parts.map((p) => p.type))).toEqual([["compaction"], ["text"], ["text"], ["text"]])
      expect(minted.map((m) => m.info.role === "user" && m.info.ordinal)).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
      ])
      expect((await Sessions.read(session.id)).prompts).toBe(1)
      expect((await Sessions.read(session.id)).current?.agent).toBe("plan")
    })
  }, 30_000)
})

describe("Stop and the messages after it", () => {
  test("a Stop the prompt's pre-write reads missed still yields a message dated after it", async () => {
    await withProject(async () => {
      const session = await root()
      await typed(session.id, "hello")
      // Written to the row only, behind the session index: every read before
      // the write transaction still sees no stop, as when a Stop lands during
      // the prompt's pre-write awaits.
      const stopped = Date.now()
      await Sessions.update(session.id, (draft) => void (draft.time.stopped = stopped))
      expect((await Session.get(session.id)).time.stopped).toBeUndefined()

      const sent = await SessionPrompt.send({
        variant: Provider.DEFAULT,
        sessionID: session.id,
        model,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "again" }],
      })

      expect(sent.message.info.time.created).toBeGreaterThan(stopped)
    })
  }, 30_000)

  test("the agent tool continuing a stopped child from a live parent runs it", async () => {
    await withProject(async () => {
      const parent = await root()
      const opener = await typed(parent.id, "go")
      const sub = await child(parent.id)
      const first = await typed(sub.id, "count")
      await assistant(sub.id, first.info.id, "3 files")
      await Session.stop({ sessionID: sub.id })

      const reply = await assistant(parent.id, opener.info.id, "")
      state.replies.push("5 files", "5 files", "5 files")
      const continued = await (await tool(parent.id, reply.id))({ session_id: sub.id, prompt: "count again" })

      expect(continued.metadata).toMatchObject({ mode: "continued" })
      await until(async () => !(await Debt.has(sub.id)), "the child to report")
      const texts = (await Session.messages({ sessionID: sub.id })).flatMap((m) =>
        m.info.role === "assistant" ? m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])) : [],
      )
      expect(texts.slice(0, 2)).toEqual(["3 files", "5 files"])
    })
  }, 30_000)
})

describe("shell", () => {
  test("a shell command counts as a prompt, moves current, and runs as a turn", async () => {
    await withProject(async () => {
      const session = await root()
      await typed(session.id, "hello")
      const seen: boolean[] = []
      const listen = Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
        if (event.properties.part.sessionID === session.id && event.properties.part.type === "tool")
          seen.push(SessionBusy.busy(session.id))
      })
      await SessionPrompt.shell({
        sessionID: session.id,
        agent: "plan",
        model,
        variant: Provider.INHERIT,
        command: "echo hi",
      })
      listen()

      const shellMsg = (await users(session.id)).at(-1)!
      expect(shellMsg.info.role === "user" && shellMsg.info.ordinal).toBe(2)
      expect(shellMsg.info.role === "user" && shellMsg.info.synthetic).toBe(true)
      expect(shellMsg.parts.map((p) => p.type === "text" && p.synthetic)).toEqual([true])
      expect((await Sessions.read(session.id)).current?.agent).toBe("plan")
      expect(seen.length > 0 && seen.every(Boolean)).toBe(true)
      expect(SessionBusy.busy(session.id)).toBe(false)
    })
  }, 30_000)

  test("a shell command opening a session titles it from the command", async () => {
    await withProject(async () => {
      const session = await root()
      await SessionPrompt.shell({
        sessionID: session.id,
        agent: "build",
        model,
        variant: Provider.INHERIT,
        command: "ls -la src",
      })

      const shellMsg = (await users(session.id)).at(-1)!
      expect(shellMsg.info.role === "user" && shellMsg.info.ordinal).toBe(1)
      expect((await Session.get(session.id)).title).toBe("ls -la src")
    })
  }, 30_000)

  test("a prompt sent while a shell command runs is answered once the command ends", async () => {
    await withProject(async () => {
      const session = await root()
      await typed(session.id, "hello")
      const shell = SessionPrompt.shell({
        sessionID: session.id,
        agent: "build",
        model,
        variant: Provider.INHERIT,
        command: "sleep 1",
      })
      await until(() => SessionBusy.busy(session.id), "the shell to run")

      // The title request races the answer for the first reply.
      state.replies.push("answered", "answered")
      const answer = await SessionPrompt.prompt({
        variant: Provider.INHERIT,
        sessionID: session.id,
        model,
        agent: "build",
        parts: [{ type: "text", text: "and then?" }],
      })
      await shell

      expect(answer.info.role).toBe("assistant")
      expect(answer.parts.flatMap((p) => (p.type === "text" ? [p.text] : []))).toEqual(["answered"])
    })
  }, 30_000)
})

describe("the write itself", () => {
  test("a claimed delivery clears a pending revert first, so the next prompt keeps the result", async () => {
    await withProject(async () => {
      const session = await root()
      await typed(session.id, "hello")
      const undone = await typed(session.id, "undo me")
      await Session.update(session.id, (draft) => void (draft.revert = { messageID: undone.info.id }))

      const delivered = await SessionPrompt.deliver({
        model: Provider.DEFAULT,
        variant: Provider.DEFAULT,
        sessionID: session.id,
        parts: [{ type: "text", text: "a result", synthetic: true }],
        claim: () => true,
        wake: false,
      })
      await typed(session.id, "next")

      expect(delivered?.info.role).toBe("user")
      expect((await Session.get(session.id)).revert).toBeUndefined()
      expect((await users(session.id)).map((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])))).toEqual(
        [["hello"], ["a result"], ["next"]],
      )
    })
  }, 30_000)

  test("the chat.message hook edits copies, never the message being written", async () => {
    await withProject(
      async () => {
        const session = await root()
        const sent = await typed(session.id, "hello there")

        expect(sent.info.role === "user" && sent.info.agent).toBe("build")
        expect(sent.parts.flatMap((p) => (p.type === "text" ? [p.text] : []))).toEqual(["hello there"])
        expect((await Session.get(session.id)).title).toBe("hello there")
      },
      `export default async () => ({
        "chat.message": async (_input, output) => {
          output.message.agent = "mutated"
          for (const part of output.parts) if (part.type === "text") part.text = "mutated"
        },
      })`,
    )
  }, 30_000)

  test("a message that changes no session fact publishes no session update from its write", async () => {
    await withProject(async () => {
      const session = await root()
      await typed(session.id, "hello")
      const writes: string[] = []
      const listen = Bus.subscribe(Session.Event.Updated, (event) => {
        if (event.properties.info.id !== session.id) return
        writes.push(new Error().stack?.includes("createUserMessage") ? "write" : "other")
      })

      await SessionPrompt.deliver({
        model: Provider.DEFAULT,
        variant: Provider.DEFAULT,
        sessionID: session.id,
        parts: [{ type: "text", text: "a result", synthetic: true }],
        claim: () => true,
        wake: false,
      })
      const synthetic = writes.filter((write) => write === "write").length
      await typed(session.id, "again")
      listen()

      expect(synthetic).toBe(0)
      expect(writes.filter((write) => write === "write").length).toBe(1)
    })
  }, 30_000)
})

describe("failures", () => {
  test("a failed prompt() into a child reports failed once", async () => {
    await withProject(async () => {
      const parent = await root()
      await typed(parent.id, "go")
      const sub = await child(parent.id)
      const missing = { providerID: "anthropic", modelID: "no-such-model" }
      const outcome = await SessionPrompt.prompt({
        variant: Provider.DEFAULT,
        sessionID: sub.id,
        model: missing,
        agent: "build",
        parts: [{ type: "text", text: "count" }],
      }).then(
        () => "resolved",
        () => "rejected",
      )
      expect(outcome).toBe("rejected")
      await until(async () => !(await Debt.has(sub.id)), "the failure to be reported")
      const reports = (await Session.messages({ sessionID: parent.id }))
        .flatMap((m) => m.parts)
        .flatMap((p) => (p.type === "text" && p.backgroundSubagentResult ? [p.backgroundSubagentResult.status] : []))
      expect(reports).toEqual(["failed"])
    })
  }, 30_000)
})

// Every user message goes through createUserMessage, reached via
// SessionPrompt.deliver / send / prompt / shell. Session.copy (fork, context
// hand-off) clones messages that already exist and is the one exception.
describe("one writer of user messages", () => {
  test("no file but session/prompt.ts writes a user-role message directly", async () => {
    const src = path.join(import.meta.dir, "../../src")
    const writers = /Session\.updateMessage\(|Messages\.(put|writer|reconcile)\(|\bupdateMessage\(/
    const allowed = new Set(["session/prompt.ts", "storage/messages.ts"])
    const offenders: string[] = []
    for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: src })) {
      if (allowed.has(file)) continue
      const text = await Bun.file(path.join(src, file)).text()
      if (!writers.test(text)) continue
      const body = file === "session/index.ts" ? text.replace(/export async function copy[\s\S]*?\n  }\n/, "") : text
      // A write call whose argument (up to its closing brace) builds a user role.
      const calls = body.match(
        /(Session\.updateMessage|Messages\.(put|writer|reconcile)|\bupdateMessage)\(\{[\s\S]{0,600}?role: "user"/g,
      )
      if (calls) offenders.push(file)
    }
    expect(
      offenders.map((file) => `${file} writes a user message directly; use SessionPrompt.deliver instead`),
    ).toEqual([])
  })

  // A transcript user message is built only to be written, so building one is
  // the first half of a second writer. A `user:` property is the request's
  // user handed to LLM.stream (judge, oneshot, webfetch), never written; a
  // model message (`role` plus `content`) carries no sessionID.
  test("no file but session/prompt.ts builds a transcript user message", async () => {
    const src = path.join(import.meta.dir, "../../src")
    const allowed = new Set(["session/prompt.ts", "cli/cmd/import.ts"])
    const offenders: string[] = []
    for await (const file of new Bun.Glob("{session,tool,background,cli}/**/*.ts").scan({ cwd: src })) {
      if (allowed.has(file)) continue
      const text = await Bun.file(path.join(src, file)).text()
      const body = file === "session/index.ts" ? text.replace(/export async function copy[\s\S]*?\n  }\n/, "") : text
      const typed = /: MessageV2\.User = \{/.test(body)
      const literals = [...body.matchAll(/role: "user"/g)].filter((match) => {
        const before = body.slice(Math.max(0, match.index - 300), match.index)
        const after = body.slice(match.index, match.index + 300)
        const brace = before.lastIndexOf("{")
        if (/user: \{$/.test(before.slice(0, brace + 1))) return false
        return /\bsessionID\b/.test(before.slice(brace) + after.slice(0, after.indexOf("}")))
      })
      if (typed || literals.length > 0) offenders.push(file)
    }
    expect(offenders.map((file) => `${file} builds a user message; use SessionPrompt.deliver instead`)).toEqual([])
  })
})

describe("a message joining a running turn", () => {
  test("reaches the next step's request as typed", async () => {
    await withProject(async () => {
      const session = await root()
      const release = Promise.withResolvers<void>()
      state.gate = release.promise
      state.replies.push(toolCall, "done")
      const turn = SessionPrompt.prompt({
        variant: Provider.INHERIT,
        sessionID: session.id,
        model,
        agent: "build",
        parts: [{ type: "text", text: "start" }],
      })
      await until(() => state.requests.some((body) => body.tools), "the first step's request")
      const joined = SessionPrompt.prompt({
        variant: Provider.INHERIT,
        sessionID: session.id,
        model,
        agent: "build",
        parts: [{ type: "text", text: "and also this" }],
      })
      await until(async () => (await users(session.id)).length === 2, "the joined message to be written")
      release.resolve()
      await Promise.all([turn, joined])

      const steps = state.requests.filter((body) => body.tools)
      const texts = JSON.stringify(steps[1].messages)
      expect(texts).toContain(JSON.stringify("and also this"))
      expect(texts).not.toContain("The user sent the following message")
    })
  }, 30_000)

  test("a job result that joins reaches the next step's request as delivered", async () => {
    await withProject(async () => {
      const session = await root()
      const release = Promise.withResolvers<void>()
      state.gate = release.promise
      state.replies.push(toolCall, "done")
      const turn = SessionPrompt.prompt({
        variant: Provider.INHERIT,
        sessionID: session.id,
        model,
        agent: "build",
        parts: [{ type: "text", text: "start" }],
      })
      await until(() => state.requests.some((body) => body.tools), "the first step's request")
      await job("job_joins_turn", session.id)
      await Recovery.collect(session.id, { fresh: true })
      expect(await jobResults(session.id)).toEqual(["job_joins_turn"])
      release.resolve()
      await turn

      const notice = (await Session.messages({ sessionID: session.id }))
        .flatMap((m) => m.parts)
        .find((p) => p.type === "text" && p.backgroundJobResult)
      const steps = state.requests.filter((body) => body.tools)
      const texts = JSON.stringify(steps[1].messages)
      expect(texts).toContain(JSON.stringify(notice?.type === "text" ? notice.text : undefined))
      expect(texts).not.toContain("has finished while you were working")
      expect(texts).not.toContain("The user sent the following message")
    })
  }, 30_000)

  test("a result that joins after a plan switch runs as the switched-to agent", async () => {
    await withProject(
      async () => {
        const session = await root()
        const release = Promise.withResolvers<void>()
        state.gate = release.promise
        state.replies.push(toolCall, "done")
        const turn = SessionPrompt.prompt({
          variant: Provider.INHERIT,
          sessionID: session.id,
          model,
          agent: "plan",
          parts: [{ type: "text", text: "plan it" }],
        })
        await until(() => state.requests.some((body) => body.tools), "the first step's request")
        const step = (await Session.messages({ sessionID: session.id })).findLast((m) => m.info.role === "assistant")!
        const switched = Bus.subscribe(Question.Event.Asked, (event) =>
          Question.reply({ requestID: event.properties.id, answers: [["Yes"]] }),
        )
        const exit = await PlanExitTool.init()
        await exit.execute(
          {},
          {
            sessionID: session.id,
            messageID: step.info.id,
            agent: "plan",
            abort: new AbortController().signal,
            callID: "call_plan_exit",
            extra: {},
            messages: [],
            metadata: () => {},
            ask: async () => {},
          },
        )
        switched()
        await job("job_after_switch", session.id)
        await Recovery.collect(session.id, { fresh: true })
        release.resolve()
        await turn

        const notice = (await users(session.id)).find((m) =>
          m.parts.some((p) => p.type === "text" && p.backgroundJobResult?.jobId === "job_after_switch"),
        )
        expect(notice?.info.role === "user" && notice.info.agent).toBe("build")
        expect((await Sessions.read(session.id)).current?.agent).toBe("build")

        // The switch changes only what is appended: the step after it sends the
        // first step's tools, system and every content block unchanged. Needs
        // plan_enter and plan_exit allowed for both agents, as the "*": "allow"
        // permission here does; the built-in defaults deny each to one agent,
        // which strips it from that agent's tools[].
        const steps = state.requests.filter((body) => body.tools)
        expect(steps.length).toBe(2)
        expect(JSON.stringify(steps[1].tools)).toBe(JSON.stringify(steps[0].tools))
        expect(JSON.stringify(steps[1].system)).toBe(JSON.stringify(steps[0].system))
        // The rolling 5m marker moves to the newest block each step; it is not
        // part of the hashed content, so it is left out of the comparison.
        const blocks = (body: (typeof steps)[number]) =>
          (body.messages as { role: string; content: Record<string, unknown>[] }[]).flatMap((m) =>
            m.content.map((block) => JSON.stringify([m.role, { ...block, cache_control: undefined }])),
          )
        const sent = blocks(steps[0])
        expect(blocks(steps[1]).slice(0, sent.length)).toEqual(sent)
      },
      undefined,
      { config: { permission: { "*": "allow" } } },
    )
  }, 30_000)
})

describe("the agent and model a person last sent", () => {
  const haiku = { providerID: "anthropic", modelID: "claude-3-5-haiku-20241022" }

  async function sent(sessionID: string, agent: string, pick: typeof model) {
    state.replies.push("ok")
    await SessionPrompt.prompt({
      variant: Provider.INHERIT,
      sessionID,
      model: pick,
      agent,
      parts: [{ type: "text", text: "go" }],
    })
  }

  async function landed(sessionID: string, id: string) {
    const message = (await users(sessionID)).find((m) =>
      m.parts.some((p) => p.type === "text" && p.backgroundJobResult?.jobId === id),
    )
    return message?.info.role === "user" ? { agent: message.info.agent, model: message.info.model } : undefined
  }

  test("run a result that starts a turn after that send went idle", async () => {
    await withProject(async () => {
      const session = await root()
      await sent(session.id, "build", model)
      await sent(session.id, "plan", haiku)
      state.replies.push("ok")
      await job("job_after_idle", session.id)
      await Recovery.collect(session.id, { fresh: true })
      await until(() => !SessionBusy.busy(session.id), "the result's turn to end")
      expect(await landed(session.id, "job_after_idle")).toEqual({ agent: "plan", model: haiku })
    })
  }, 30_000)

  test("run a result that joins the turn that send opened", async () => {
    await withProject(async () => {
      const session = await root()
      await sent(session.id, "build", model)
      const release = Promise.withResolvers<void>()
      state.gate = release.promise
      state.replies.push(toolCall, "done")
      const turn = SessionPrompt.prompt({
        variant: Provider.INHERIT,
        sessionID: session.id,
        model: haiku,
        agent: "plan",
        parts: [{ type: "text", text: "continue" }],
      })
      await until(() => state.requests.filter((body) => body.tools).length === 2, "the second turn's first step")
      await job("job_joins_sent", session.id)
      await Recovery.collect(session.id, { fresh: true })
      release.resolve()
      await turn
      expect(await landed(session.id, "job_joins_sent")).toEqual({ agent: "plan", model: haiku })
    })
  }, 30_000)

  test("run a command that names no agent", async () => {
    await withProject(
      async () => {
        const session = await root()
        await sent(session.id, "plan", model)
        state.replies.push("ok", "ok")
        await SessionPrompt.command({
          sessionID: session.id,
          command: "hi",
          arguments: "",
          model: Provider.INHERIT,
          variant: Provider.INHERIT,
        })
        const written = await users(session.id)
        const last = written[written.length - 1].info
        expect(last.role === "user" && last.agent).toBe("plan")
      },
      undefined,
      { command: { hi: { template: "say hi" } } },
    )
  }, 30_000)

  test("run a subagent command that names no agent", async () => {
    await withProject(
      async () => {
        const session = await root()
        await sent(session.id, "plan", model)
        state.replies.push("ok", "ok", "ok", "ok")
        await SessionPrompt.command({
          sessionID: session.id,
          command: "sub",
          arguments: "",
          model: Provider.INHERIT,
          variant: Provider.INHERIT,
        })
        const written = await users(session.id)
        const last = written[written.length - 1].info
        expect(last.role === "user" && last.agent).toBe("plan")
        expect((await Sessions.read(session.id)).current?.agent).toBe("plan")
      },
      undefined,
      { command: { sub: { template: "do sub", agent: "general", subagent: true } } },
    )
  }, 30_000)

  test("run a command on the default agent when the session's agent is gone", async () => {
    await withProject(
      async () => {
        const session = await root()
        await sent(session.id, "build", model)
        await Session.update(session.id, (draft) => void (draft.current!.agent = "ghost"))
        state.replies.push("ok")
        await SessionPrompt.command({
          sessionID: session.id,
          command: "hi",
          arguments: "",
          model: Provider.INHERIT,
          variant: Provider.INHERIT,
        })
        const written = await users(session.id)
        const last = written[written.length - 1].info
        expect(last.role === "user" && last.agent).toBe("build")
      },
      undefined,
      { command: { hi: { template: "say hi" } } },
    )
  }, 30_000)

  test("refuse a command that names an agent that does not exist", async () => {
    await withProject(
      async () => {
        const session = await root()
        await sent(session.id, "build", model)
        const refused = SessionPrompt.command({
          sessionID: session.id,
          command: "hi",
          arguments: "",
          agent: "ghost",
          model: Provider.INHERIT,
          variant: Provider.INHERIT,
        })
        await expect(refused).rejects.toMatchObject({
          data: { message: expect.stringContaining('Agent not found: "ghost".') },
        })
      },
      undefined,
      { command: { hi: { template: "say hi" } } },
    )
  }, 30_000)

  // A plan switch still writing when its turn is cancelled and a new prompt
  // claims the next turn: the switch must not take over that turn's
  // parameters, or a later prompt that finds them left behind joins as if
  // that turn still ran.
  test("a switch that lands after its turn ended leaves the next turn's parameters alone", async () => {
    const gates = globalThis as unknown as {
      __gates: Record<string, PromiseWithResolvers<void>>
      __entered: string[]
    }
    gates.__gates = { SWITCH: Promise.withResolvers<void>(), P: Promise.withResolvers<void>() }
    gates.__entered = []
    await withProject(
      async () => {
        const session = await root()
        await sent(session.id, "plan", model)
        const switching = SessionPrompt.deliver({
          sessionID: session.id,
          parts: [{ type: "text", text: "SWITCH", synthetic: true, internal: true }],
          model: Provider.INHERIT,
          variant: Provider.INHERIT,
          params: { agent: "build" },
          join: true,
          wake: false,
        })
        await until(() => gates.__entered.includes("SWITCH"), "the switch to reach its write")
        const failing = SessionPrompt.prompt({
          variant: Provider.INHERIT,
          sessionID: session.id,
          model,
          agent: "plan",
          parts: [{ type: "text", text: "P" }],
        }).catch((error: unknown) => String(error))
        await until(() => gates.__entered.includes("P"), "the next prompt to claim its turn")
        gates.__gates.SWITCH.resolve()
        await switching
        gates.__gates.P.resolve()
        expect(await failing).toBe("Error: P fails after its write")
        state.replies.push("ok")
        await SessionPrompt.prompt({
          variant: Provider.INHERIT,
          sessionID: session.id,
          model,
          agent: "plan",
          parts: [{ type: "text", text: "Q" }],
        })
        const next = (await users(session.id)).find((m) => m.parts.some((p) => p.type === "text" && p.text === "Q"))
        expect(next?.info.role === "user" && next.info.agent).toBe("plan")
        await until(() => !SessionBusy.busy(session.id), "the session to go idle")
      },
      `export default async () => ({
        "chat.message": async (_input, output) => {
          const text = output.parts.find((p) => p.type === "text")?.text
          const gate = globalThis.__gates?.[text]
          if (!gate) return
          globalThis.__entered.push(text)
          await gate.promise
          if (text === "P") throw new Error("P fails after its write")
        },
      })`,
    )
  }, 30_000)

  // An Esc ends a turn before its loop has unwound. A prompt sent in that gap
  // starts the next turn; the old loop's end must not cancel it or drop its
  // parameters.
  test("an interrupted turn's unwind leaves the next turn running", async () => {
    const hooks = globalThis as unknown as { __hold?: PromiseWithResolvers<void>; __held?: boolean }
    await withProject(
      async () => {
        const session = await root()
        await sent(session.id, "build", model)
        const hold = Promise.withResolvers<void>()
        hooks.__hold = hold
        hooks.__held = false
        const old = SessionPrompt.prompt({
          variant: Provider.INHERIT,
          sessionID: session.id,
          model,
          agent: "build",
          parts: [{ type: "text", text: "old" }],
        })
        await until(() => hooks.__held === true, "the old turn to reach its hook")
        await Session.interrupt(session.id)

        const release = Promise.withResolvers<void>()
        state.gate = release.promise
        state.replies.push("NEW-REPLY", "JOIN-REPLY")
        const before = state.requests.filter((body) => body.tools).length
        const fresh = SessionPrompt.prompt({
          variant: Provider.INHERIT,
          sessionID: session.id,
          model,
          agent: "build",
          parts: [{ type: "text", text: "new" }],
        })
        await until(() => state.requests.filter((body) => body.tools).length > before, "the new turn's request")
        hold.resolve()
        await old
        expect(SessionBusy.busy(session.id)).toBe(true)

        const joined = SessionPrompt.prompt({
          variant: Provider.INHERIT,
          sessionID: session.id,
          model,
          agent: "plan",
          parts: [{ type: "text", text: "join" }],
        })
        await until(
          async () =>
            (await users(session.id)).some((m) => m.parts.some((p) => p.type === "text" && p.text === "join")),
          "the joined message",
        )
        release.resolve()
        await Promise.all([fresh, joined])

        const messages = await Session.messages({ sessionID: session.id })
        const opener = messages.find((m) => m.parts.some((p) => p.type === "text" && p.text === "new"))!
        const reply = messages.find((m) => m.info.role === "assistant" && m.info.parentID === opener.info.id)!
        expect(reply.info.role === "assistant" && reply.info.error).toBeUndefined()
        expect(reply.parts.flatMap((p) => (p.type === "text" ? [p.text] : []))).toEqual(["NEW-REPLY"])
        const join = messages.find((m) => m.parts.some((p) => p.type === "text" && p.text === "join"))!
        expect(join.info.role === "user" && join.info.agent).toBe("build")
      },
      `export default async () => ({
        "experimental.chat.messages.transform": async () => {
          const hold = globalThis.__hold
          if (!hold) return
          globalThis.__hold = undefined
          globalThis.__held = true
          await hold.promise
        },
      })`,
    )
  }, 30_000)

  // The same gap, with the next prompt still being written (its turn claimed,
  // its loop not yet started) when the old loop unwinds.
  test("an interrupted turn's unwind leaves a prompt still being written its turn", async () => {
    const hooks = globalThis as unknown as {
      __hold?: PromiseWithResolvers<void>
      __held?: boolean
      __pgate?: PromiseWithResolvers<void>
      __pentered?: boolean
    }
    await withProject(
      async () => {
        const session = await root()
        await sent(session.id, "build", model)
        const hold = Promise.withResolvers<void>()
        hooks.__hold = hold
        hooks.__held = false
        const old = SessionPrompt.prompt({
          variant: Provider.INHERIT,
          sessionID: session.id,
          model,
          agent: "build",
          parts: [{ type: "text", text: "old" }],
        })
        await until(() => hooks.__held === true, "the old turn to reach its hook")
        await Session.interrupt(session.id)

        const writing = Promise.withResolvers<void>()
        hooks.__pgate = writing
        hooks.__pentered = false
        const release = Promise.withResolvers<void>()
        state.gate = release.promise
        state.replies.push("NEW-REPLY", "JOIN-REPLY")
        const before = state.requests.filter((body) => body.tools).length
        const fresh = SessionPrompt.prompt({
          variant: Provider.INHERIT,
          sessionID: session.id,
          model,
          agent: "build",
          parts: [{ type: "text", text: "new" }],
        })
        await until(() => hooks.__pentered === true, "the new prompt to be mid-write")
        hold.resolve()
        await old
        writing.resolve()
        await until(() => state.requests.filter((body) => body.tools).length > before, "the new turn's request")

        const joined = SessionPrompt.prompt({
          variant: Provider.INHERIT,
          sessionID: session.id,
          model,
          agent: "plan",
          parts: [{ type: "text", text: "join" }],
        })
        await until(
          async () => (await users(session.id)).some((m) => m.parts.some((p) => p.type === "text" && p.text === "join")),
          "the joined message",
        )
        release.resolve()
        await Promise.all([fresh, joined])

        const join = (await users(session.id)).find((m) =>
          m.parts.some((p) => p.type === "text" && p.text === "join"),
        )!
        expect(join.info.role === "user" && join.info.agent).toBe("build")
        expect((await Sessions.read(session.id)).current?.agent).toBe("build")
      },
      `export default async () => ({
        "chat.message": async (_input, output) => {
          const text = output.parts.find((p) => p.type === "text")?.text
          if (text !== "new" || !globalThis.__pgate) return
          const gate = globalThis.__pgate
          globalThis.__pgate = undefined
          globalThis.__pentered = true
          await gate.promise
        },
        "experimental.chat.messages.transform": async () => {
          const hold = globalThis.__hold
          if (!hold) return
          globalThis.__hold = undefined
          globalThis.__held = true
          await hold.promise
        },
      })`,
    )
  }, 30_000)

  test("dispatch a command whose own agent is a subagent", async () => {
    await withProject(
      async () => {
        const session = await root()
        await sent(session.id, "build", model)
        state.replies.push("ok", "ok", "ok", "ok")
        await SessionPrompt.command({
          sessionID: session.id,
          command: "sub",
          arguments: "",
          model: Provider.INHERIT,
          variant: Provider.INHERIT,
        })
        // The child's result comes back as a later user message, so the
        // dispatch is found by its part rather than by position.
        const dispatches = (await users(session.id)).filter((m) => m.parts.some((p) => p.type === "subagent"))
        expect(dispatches.map((m) => m.info.role === "user" && m.info.agent)).toEqual(["build"])
        expect(dispatches[0].parts.flatMap((p) => (p.type === "subagent" ? [p.agent] : []))).toEqual(["general"])
      },
      undefined,
      { command: { sub: { template: "do sub", agent: "general" } } },
    )
  }, 30_000)

  // A child runs its subagent, so a command typed into it with no agent of its
  // own runs inline as that agent, never as a nested subagent dispatch.
  test("run a command typed into a child inline as the child's agent", async () => {
    await withProject(
      async () => {
        const parent = await root()
        const created = await Session.create({ parentID: parent.id, title: "count files (@general subagent)" })
        made.push(created.id)
        await Session.update(created.id, (draft) => void (draft.current = { agent: "general", model }))
        state.replies.push("ok")
        await SessionPrompt.command({
          sessionID: created.id,
          command: "hi",
          arguments: "",
          model: Provider.INHERIT,
          variant: Provider.INHERIT,
        })
        const written = await users(created.id)
        const last = written[written.length - 1]
        expect(last.info.role === "user" && last.info.agent).toBe("general")
        expect(last.parts.some((p) => p.type === "subagent")).toBe(false)
        expect(last.parts.flatMap((p) => (p.type === "text" && !p.synthetic ? [p.text] : []))).toEqual(["say hi"])
      },
      undefined,
      { command: { hi: { template: "say hi" } } },
    )
  }, 30_000)

  test("run a shell command that names no agent", async () => {
    await withProject(async () => {
      const session = await root()
      await sent(session.id, "plan", model)
      await SessionPrompt.shell({
        sessionID: session.id,
        command: "echo hi",
        model: Provider.INHERIT,
        variant: Provider.INHERIT,
      })
      const messages = await Session.messages({ sessionID: session.id })
      expect(messages.slice(-2).map((m) => [m.info.role, m.info.agent])).toEqual([
        ["user", "plan"],
        ["assistant", "plan"],
      ])
      expect((await Sessions.read(session.id)).current?.agent).toBe("plan")
    })
  }, 30_000)
})

describe("commands", () => {
  const plain = { providerID: "anthropic", modelID: "claude-3-5-haiku-20241022" }

  test("inherit runs the command on the session's model", async () => {
    await withProject(
      async () => {
        const session = await root()
        await typed(session.id, "hello")
        state.replies.push("ok", "ok")
        await SessionPrompt.command({
          sessionID: session.id,
          command: "hi",
          arguments: "",
          model: Provider.INHERIT,
          variant: Provider.INHERIT,
        })
        const written = await users(session.id)
        const last = written[written.length - 1].info
        expect(last.role === "user" && last.model).toEqual(model)
      },
      undefined,
      { command: { hi: { template: "say hi" } } },
    )
  }, 30_000)

  test("a command's own model drops the client's variant for that model's own", async () => {
    await withProject(
      async () => {
        const session = await root()
        await typed(session.id, "hello")
        state.replies.push("ok", "ok")
        await SessionPrompt.command({
          sessionID: session.id,
          command: "haiku",
          arguments: "",
          model: Provider.INHERIT,
          variant: "echoed-for-sonnet",
        })
        const written = await users(session.id)
        const last = written[written.length - 1].info
        expect(last.role === "user" && last.model).toEqual(plain)
        expect(last.role === "user" && last.variant).toBeUndefined()
      },
      undefined,
      { command: { haiku: { template: "say hi", model: `${plain.providerID}/${plain.modelID}` } } },
    )
  }, 30_000)

  test("a command's own model equal to the session's keeps the client's variant", async () => {
    await withProject(
      async () => {
        const session = await root()
        await typed(session.id, "hello")
        state.replies.push("ok", "ok")
        await SessionPrompt.command({
          sessionID: session.id,
          command: "same",
          arguments: "",
          model: Provider.INHERIT,
          variant: "fast",
        })
        const written = await users(session.id)
        const last = written[written.length - 1].info
        expect(last.role === "user" && last.model).toEqual(model)
        expect(last.role === "user" && last.variant).toBe("fast")
      },
      undefined,
      {
        command: { same: { template: "say hi", model: `${model.providerID}/${model.modelID}` } },
        models: {
          [MODEL]: {
            name: "Claude Sonnet 3.5",
            family: "claude",
            release_date: "2024-10-22",
            attachment: false,
            reasoning: false,
            temperature: true,
            tool_call: true,
            cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
            limit: { context: 200000, output: 8192 },
            modalities: { input: ["text"], output: ["text"] },
            variants: { fast: {} },
          },
        },
      },
    )
  }, 30_000)

  test("a command's own model equal to the default keeps the client's variant in a session that never ran", async () => {
    await withProject(
      async () => {
        const session = await root()
        expect((await Session.get(session.id)).current).toBeUndefined()
        state.replies.push("ok", "ok")
        await SessionPrompt.command({
          sessionID: session.id,
          command: "same",
          arguments: "",
          model: Provider.INHERIT,
          variant: "fast",
        })
        const written = await users(session.id)
        const last = written[written.length - 1].info
        expect(last.role === "user" && last.model).toEqual(model)
        expect(last.role === "user" && last.variant).toBe("fast")
      },
      undefined,
      {
        command: { same: { template: "say hi", model: `${model.providerID}/${model.modelID}` } },
        models: {
          [MODEL]: {
            name: "Claude Sonnet 3.5",
            family: "claude",
            release_date: "2024-10-22",
            attachment: false,
            reasoning: false,
            temperature: true,
            tool_call: true,
            cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
            limit: { context: 200000, output: 8192 },
            modalities: { input: ["text"], output: ["text"] },
            variants: { fast: {} },
          },
        },
      },
    )
  }, 30_000)
  test("a command's own model equal to the agent's keeps the client's variant in a session that never ran", async () => {
    const spec = {
      family: "claude",
      release_date: "2024-10-22",
      attachment: false,
      reasoning: false,
      temperature: true,
      tool_call: true,
      cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      limit: { context: 200000, output: 8192 },
      modalities: { input: ["text"], output: ["text"] },
    }
    const other = { providerID: "anthropic", modelID: "claude-agent-model" }
    await withProject(
      async () => {
        const session = await root()
        expect((await Session.get(session.id)).current).toBeUndefined()
        state.replies.push("ok", "ok")
        await SessionPrompt.command({
          sessionID: session.id,
          command: "agentish",
          arguments: "",
          model: Provider.INHERIT,
          variant: "fast",
        })
        const written = await users(session.id)
        const last = written[written.length - 1].info
        expect(last.role === "user" && last.model).toEqual(other)
        expect(last.role === "user" && last.variant).toBe("fast")
      },
      undefined,
      {
        command: { agentish: { template: "say hi", model: `${other.providerID}/${other.modelID}` } },
        models: {
          [MODEL]: { name: "Claude Sonnet 3.5", ...spec },
          [other.modelID]: { name: "Agent Model", ...spec, variants: { fast: {} } },
        },
        config: { agent: { build: { model: `${other.providerID}/${other.modelID}` } } },
      },
    )
  }, 30_000)
  test("a command's own model equal to the client's concrete pick keeps the client's variant", async () => {
    const spec = {
      family: "claude",
      release_date: "2024-10-22",
      attachment: false,
      reasoning: false,
      temperature: true,
      tool_call: true,
      cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      limit: { context: 200000, output: 8192 },
      modalities: { input: ["text"], output: ["text"] },
    }
    const other = { providerID: "anthropic", modelID: "claude-picked-model" }
    await withProject(
      async () => {
        const session = await root()
        state.replies.push("ok", "ok")
        await SessionPrompt.command({
          sessionID: session.id,
          command: "picked",
          arguments: "",
          model: other,
          variant: "fast",
        })
        const written = await users(session.id)
        const last = written[written.length - 1].info
        expect(last.role === "user" && last.model).toEqual(other)
        expect(last.role === "user" && last.variant).toBe("fast")
      },
      undefined,
      {
        command: { picked: { template: "say hi", model: `${other.providerID}/${other.modelID}` } },
        models: {
          [MODEL]: { name: "Claude Sonnet 3.5", ...spec },
          [other.modelID]: { name: "Picked Model", ...spec, variants: { fast: {} } },
        },
      },
    )
  }, 30_000)
})

describe("the system a bare session sends", () => {
  async function systems(bare: boolean) {
    const found: unknown[] = []
    await withProject(
      async () => {
        const session = await Session.createNext({ directory: Instance.directory, bare })
        made.push(session.id)
        state.replies.push("answered")
        const answer = await SessionPrompt.prompt({
          variant: Provider.INHERIT,
          sessionID: session.id,
          model,
          agent: "build",
          parts: [{ type: "text", text: "hello" }],
        })
        found.push(state.requests.filter((body) => body.tools).at(-1)?.system)

        state.replies.push("pong")
        await SessionPing.probe(session.id, answer.info.id)
        await SessionPing.stop(session.id)
        found.push(state.requests.filter((body) => body.tools).at(-1)?.system)

        state.replies.push("summary")
        const messages = await Session.messages({ sessionID: session.id })
        await SessionCompaction.process({
          parentID: messages.findLast((m) => m.info.role === "user")!.info.id,
          messages,
          sessionID: session.id,
          abort: new AbortController().signal,
        })
        found.push(state.requests.filter((body) => body.tools).at(-1)?.system)
      },
      undefined,
      { agents: "PROJECT-RULE-FOR-SYSTEM" },
    )
    return found
  }

  test("a turn, a ping, and a compaction send the same system, instructions left out", async () => {
    const found = await systems(true)
    expect(found).toHaveLength(3)
    expect(found[1]).toEqual(found[0])
    expect(found[2]).toEqual(found[0])
    expect(JSON.stringify(found[0])).not.toContain("PROJECT-RULE-FOR-SYSTEM")
  }, 30_000)

  test("a normal session's three paths send the same system, instructions included", async () => {
    const found = await systems(false)
    expect(found).toHaveLength(3)
    expect(found[1]).toEqual(found[0])
    expect(found[2]).toEqual(found[0])
    expect(JSON.stringify(found[0])).toContain("PROJECT-RULE-FOR-SYSTEM")
  }, 30_000)
})
