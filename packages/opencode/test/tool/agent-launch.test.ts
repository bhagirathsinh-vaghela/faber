import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import path from "path"
import { Recovery } from "../../src/session/recovery"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionBusy } from "../../src/session/busy"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Debt } from "../../src/storage/debt"
import { Bus } from "../../src/bus"
import { MessageV2 } from "../../src/session/message-v2"
import { AgentTool } from "../../src/tool/agent"
import { Coverage } from "../../src/session/coverage"
import { Agent } from "../../src/agent/agent"
import type { Tool } from "../../src/tool/tool"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const MODEL = "claude-3-5-sonnet-20241022"
const model = { providerID: "anthropic", modelID: MODEL }

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
  for (const id of made.splice(0).reverse()) await Session.remove(id).catch(() => undefined)
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

async function project(models?: Record<string, unknown>) {
  return tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          enabled_providers: ["anthropic"],
          model: `anthropic/${MODEL}`,
          provider: {
            anthropic: { options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` }, models },
          },
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

async function assistant(sessionID: string, parentID: string, text: string, variant?: string) {
  const info = await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "assistant",
    parentID,
    mode: "build",
    agent: "build",
    variant,
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
  return Session.update(created.id, (draft) => void (draft.current = { agent: "build", model }))
}

async function results(sessionID: string) {
  return (await Session.messages({ sessionID })).flatMap((m) =>
    m.parts.flatMap((p) =>
      p.type === "text" && p.backgroundSubagentResult ? [p.backgroundSubagentResult.status] : [],
    ),
  )
}

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

// Runs `act` once, the moment a user message into a session other than
// `parentID` is written: after the launch's prompt write, before the tool
// returns.
function afterWrite(parentID: string, act: () => unknown) {
  const done = { promise: Promise.resolve() as Promise<unknown> }
  const unsubscribe = Bus.subscribe(MessageV2.Event.Updated, (event) => {
    if (event.properties.info.role !== "user" || event.properties.info.sessionID === parentID) return
    unsubscribe()
    done.promise = Promise.resolve(act())
  })
  return done
}

describe("the agent tool, interrupted before the prompt is written", () => {
  test("a turn already cancelled creates no child", async () => {
    await using tmp = await project()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await root()
        const prompt = await user(parent.id, "go")
        const reply = await assistant(parent.id, prompt.id, "")
        const turn = new AbortController()
        turn.abort()

        const run = await tool(parent.id, reply.id, turn.signal)

        await expect(run({})).rejects.toThrow(`session ${parent.id} was stopped before its subagent launched`)
        expect(await Session.children(parent.id)).toEqual([])
      },
    })
  }, 30_000)

  test("a cancel landing while the child is prepared removes it with nothing written or owed", async () => {
    await using tmp = await project()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await root()
        const prompt = await user(parent.id, "go")
        const reply = await assistant(parent.id, prompt.id, "")
        const turn = new AbortController()
        const created: string[] = []
        const unsubscribe = Bus.subscribe(Session.Event.Created, (event) => {
          if (event.properties.info.parentID !== parent.id) return
          created.push(event.properties.info.id)
          turn.abort()
        })

        const run = await tool(parent.id, reply.id, turn.signal)

        await expect(run({})).rejects.toThrow(`session ${parent.id} was stopped before its subagent launched`)
        unsubscribe()
        expect(created.length).toBe(1)
        expect(await Session.get(created[0]).catch(() => "removed")).toBe("removed")
        expect(await Session.children(parent.id)).toEqual([])
        expect((await Debt.list()).filter((debt) => debt.caller === parent.id)).toEqual([])
        expect(await results(parent.id)).toEqual([])
      },
    })
  }, 30_000)
})

describe("the agent tool, launching", () => {
  test("the child runs with the caller's model and variant, not the model's default", async () => {
    await using tmp = await project({
      [MODEL]: {
        name: "Claude",
        family: "claude",
        release_date: "2024-10-22",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
        limit: { context: 200000, output: 8192 },
        modalities: { input: ["text"], output: ["text"] },
        variant: "effort-medium",
        variants: { "effort-low": {}, "effort-medium": {} },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await root()
        const prompt = await user(parent.id, "go")
        const reply = await assistant(parent.id, prompt.id, "", "effort-low")
        state.replies.push("7 files", "ok", "ok")

        const launched = await (await tool(parent.id, reply.id))({})

        const childID = launched.metadata.sessionId as string
        made.push(childID)
        const first = (await Session.messages({ sessionID: childID })).find((m) => m.info.role === "user")!
        expect(first.info.role === "user" && first.info.variant).toBe("effort-low")
        expect((await Session.get(childID)).current?.variant).toBe("effort-low")
        await until(async () => !(await Debt.has(childID)), "the child to report")
        await until(() => !SessionBusy.busy(childID), `${childID} to go idle`)
      },
    })
  }, 30_000)
})

describe("the agent tool, recording what the child was asked at", () => {
  for (const [name, skills, recorded] of [
    ["a caller running a reminder skill records its content fingerprint", ["review-skill"], true],
    ["a caller running none records nothing", [], false],
  ] as const) {
    test(
      name,
      async () => {
        await using repo = await project()
        await Instance.provide({
          directory: repo.path,
          fn: async () => {
            const parent = await root()
            await Session.update(parent.id, (draft) => void (draft.activeSkills = [...skills]))
            const prompt = await user(parent.id, "go")
            const reply = await assistant(parent.id, prompt.id, "")
            state.replies.push("0 findings", "ok", "ok")
            const expected = recorded ? await Coverage.fingerprint(parent.id) : undefined

            const launched = await (await tool(parent.id, reply.id))({})

            const childID = launched.metadata.sessionId as string
            made.push(childID)
            await until(async () => !(await Debt.has(childID)), "the child to report")
            await until(() => !SessionBusy.busy(childID), `${childID} to go idle`)
            expect((await Session.get(childID)).asked).toBe(expected)
            const trees = (await Session.messages({ sessionID: parent.id })).flatMap((m) =>
              m.parts.flatMap((p) =>
                p.type === "text" && p.backgroundSubagentResult ? [p.backgroundSubagentResult.tree] : [],
              ),
            )
            expect(trees).toEqual([expected])
          },
        })
      },
      30_000,
    )
  }

  test("a child continued after the skill ended carries no stale fingerprint onto its result", async () => {
    await using repo = await project()
    await Instance.provide({
      directory: repo.path,
      fn: async () => {
        const parent = await root()
        await Session.update(parent.id, (draft) => void (draft.activeSkills = ["review-skill"]))
        const prompt = await user(parent.id, "go")
        const reply = await assistant(parent.id, prompt.id, "")
        state.replies.push("0 findings", "ok", "ok", "still 0", "ok", "ok")
        const run = await tool(parent.id, reply.id)
        const childID = (await run({})).metadata.sessionId as string
        made.push(childID)
        await until(async () => !(await Debt.has(childID)), "the child to report")
        await until(() => !SessionBusy.busy(childID), `${childID} to go idle`)
        expect((await Session.get(childID)).asked).toBeDefined()

        await Session.update(parent.id, (draft) => void (draft.activeSkills = []))
        await run({ session_id: childID, prompt: "again" })
        await until(async () => !(await Debt.has(childID)), "the child to report again")
        await until(() => !SessionBusy.busy(childID), `${childID} to go idle again`)
        expect((await Session.get(childID)).asked).toBeUndefined()
        const trees = (await Session.messages({ sessionID: parent.id })).flatMap((m) =>
          m.parts.flatMap((p) =>
            p.type === "text" && p.backgroundSubagentResult ? [p.backgroundSubagentResult.tree] : [],
          ),
        )
        expect(trees.length).toBe(2)
        expect(trees[1]).toBeUndefined()
      },
    })
  }, 30_000)
})

describe("the agent tool, continuing", () => {
  test("a continued child with no caller variant keeps its own, not the model's default", async () => {
    await using tmp = await project({
      [MODEL]: {
        name: "Claude",
        family: "claude",
        release_date: "2024-10-22",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
        limit: { context: 200000, output: 8192 },
        modalities: { input: ["text"], output: ["text"] },
        variant: "effort-medium",
        variants: { "effort-low": {}, "effort-medium": {} },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await root()
        const sub = await child(parent.id)
        await Session.update(sub.id, (draft) => void (draft.current = { agent: "build", model, variant: "effort-low" }))
        const asked = await user(sub.id, "count")
        await assistant(sub.id, asked.id, "7 files", "effort-low")
        const prompt = await user(parent.id, "go")
        const reply = await assistant(parent.id, prompt.id, "")
        state.replies.push("8 files", "ok", "ok")

        await (
          await tool(parent.id, reply.id)
        )({ session_id: sub.id })

        const users = (await Session.messages({ sessionID: sub.id })).filter((m) => m.info.role === "user")
        const last = users[users.length - 1]
        expect(last.info.role === "user" && last.info.variant).toBe("effort-low")
        await until(async () => !(await Debt.has(sub.id)), "the child to report")
        await until(() => !SessionBusy.busy(sub.id), `${sub.id} to go idle`)
      },
    })
  }, 30_000)
})

describe("the agent tool, interrupted after the prompt is written", () => {
  test("an Esc lets the launch complete: the child runs and the parent gets one report", async () => {
    await using tmp = await project()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await root()
        const prompt = await user(parent.id, "go")
        const reply = await assistant(parent.id, prompt.id, "")
        const turn = new AbortController()
        afterWrite(parent.id, () => turn.abort())
        state.replies.push("7 files", "ok", "ok")

        const launched = await (await tool(parent.id, reply.id, turn.signal))({})

        expect(turn.signal.aborted).toBe(true)
        expect(launched.metadata).toMatchObject({ mode: "launched" })
        const childID = launched.metadata.sessionId as string
        made.push(childID)
        await until(async () => !(await Debt.has(childID)), "the child to report")
        await until(() => !SessionBusy.busy(childID), `${childID} to go idle`)
        expect(await results(parent.id)).toEqual(["completed"])
      },
    })
  }, 30_000)

  test("a Stop removes the child it created, and the debt with it", async () => {
    await using tmp = await project()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await root()
        const prompt = await user(parent.id, "go")
        const reply = await assistant(parent.id, prompt.id, "")
        const turn = new AbortController()
        const stop = afterWrite(parent.id, () => turn.abort(SessionPrompt.STOPPED))
        state.hold = Promise.withResolvers<void>().promise

        const run = await tool(parent.id, reply.id, turn.signal)

        await expect(run({})).rejects.toThrow(`session ${parent.id} was stopped before its subagent launched`)
        await stop.promise
        expect(await Session.children(parent.id)).toEqual([])
        expect((await Debt.list()).filter((debt) => debt.caller === parent.id)).toEqual([])
        expect(await results(parent.id)).toEqual([])
      },
    })
  }, 30_000)

  test("a Stop leaves a continued child to the Stop, which reports it cancelled", async () => {
    await using tmp = await project()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await root()
        const sub = await child(parent.id)
        const asked = await user(sub.id, "count")
        await assistant(sub.id, asked.id, "7 files")
        const prompt = await user(parent.id, "go")
        const reply = await assistant(parent.id, prompt.id, "")
        const turn = new AbortController()
        const stop = afterWrite(parent.id, async () => {
          turn.abort(SessionPrompt.STOPPED)
          await Session.stop({ sessionID: parent.id })
        })

        const run = await tool(parent.id, reply.id, turn.signal)

        await expect(run({ session_id: sub.id })).resolves.toMatchObject({ metadata: { mode: "continued" } })
        await stop.promise
        await until(() => !SessionBusy.busy(sub.id), `${sub.id} to go idle`)
        await until(async () => !(await Debt.has(sub.id)), "the child's debt to be paid")
        expect((await Session.get(sub.id)).time.stopped).toBeGreaterThanOrEqual(reply.time.created)
        expect(await Session.children(parent.id)).toEqual([expect.objectContaining({ id: sub.id })])
        expect(await results(parent.id)).toEqual(["cancelled"])
      },
    })
  }, 30_000)
})

describe("the agent tool, steering a busy child", () => {
  test("the steer is answered and the parent gets one report", async () => {
    await using tmp = await project()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await root()
        const sub = await child(parent.id)
        await Debt.add(sub.id, "subagent", parent.id)
        await user(sub.id, "count")
        const release = Promise.withResolvers<void>()
        state.hold = release.promise
        void SessionPrompt.loop(sub.id).catch(() => {})
        await until(() => SessionBusy.busy(sub.id), `${sub.id} to run`)
        const prompt = await user(parent.id, "go")
        const reply = await assistant(parent.id, prompt.id, "")

        const steered = await (await tool(parent.id, reply.id))({ session_id: sub.id, prompt: "recount" })

        expect(steered.metadata).toMatchObject({ mode: "steered", sessionId: sub.id })
        state.hold = undefined
        release.resolve()
        await until(async () => !(await Debt.has(sub.id)), "the child to report")
        await until(() => !SessionBusy.busy(sub.id), `${sub.id} to go idle`)
        const messages = await Session.messages({ sessionID: sub.id })
        const steer = messages.findLastIndex((m) => m.info.role === "user")
        const answer = messages.findLast((m) => m.info.role === "assistant")
        expect(messages.indexOf(answer!)).toBeGreaterThan(steer)
        expect(answer!.info.role === "assistant" && answer!.info.time.completed !== undefined).toBe(true)
        expect(await results(parent.id)).toEqual(["completed"])
      },
    })
  }, 30_000)
})
