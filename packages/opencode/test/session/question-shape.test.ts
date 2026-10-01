import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { Session } from "../../src/session"
import { Sessions } from "../../src/storage/sessions"
import { SessionPrompt } from "../../src/session/prompt"
import { Instance } from "../../src/project/instance"
import { Question } from "../../src/question"
import { Bus } from "../../src/bus"
import { Provider } from "../../src/provider/provider"
import { Recovery } from "../../src/session/recovery"
import { SessionCompaction } from "../../src/session/compaction"
import { PermissionNext } from "../../src/permission/next"
import { Identifier } from "../../src/id/id"
import { MessageV2 } from "../../src/session/message-v2"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

// A fake Anthropic endpoint: each turn request takes the next queued reply and
// its body is kept, so a test reads exactly what the next request put on the
// wire. A request with no tools is a side call (the title) and gets filler.
const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  queue: [] as (() => Response)[],
  bodies: [] as Record<string, any>[],
}

// The question tool is registered only for a client that can show it.
const client = process.env.OPENCODE_CLIENT

beforeAll(() => {
  process.env.OPENCODE_CLIENT = "app"
  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Record<string, any>
      if (!body.tools?.length) return reply([text("a title")], "end_turn")
      state.bodies.push(body)
      return (state.queue.shift() ?? (() => reply([text("fallback")], "end_turn")))()
    },
  })
})

beforeEach(() => {
  state.queue.length = 0
  state.bodies.length = 0
  Recovery.start()
})

afterAll(() => {
  Recovery.stop()
  state.server?.stop()
  if (client === undefined) delete process.env.OPENCODE_CLIENT
  if (client !== undefined) process.env.OPENCODE_CLIENT = client
})

const MODEL = "claude-3-5-sonnet-20241022"

function text(value: string) {
  return [
    { type: "content_block_start", content_block: { type: "text", text: "" } },
    { type: "content_block_delta", delta: { type: "text_delta", text: value } },
    { type: "content_block_stop" },
  ]
}

function toolUse(name: string, input: unknown, id = "toolu_q") {
  return [
    { type: "content_block_start", content_block: { type: "tool_use", id, name, input: {} } },
    { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "content_block_stop" },
  ]
}

function reply(blocks: Record<string, any>[][], stop: string) {
  const chunks = [
    { type: "message_start", message: { id: "msg-1", model: MODEL, usage: { input_tokens: 20 } } },
    ...blocks.flatMap((block, index) => block.map((chunk) => ({ ...chunk, index }))),
    { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 6 } },
    { type: "message_stop" },
  ]
  const payload = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n") + "\n\n"
  return new Response(payload, { status: 200, headers: { "Content-Type": "text/event-stream" } })
}

// `extra` is merged into the project's opencode.json; `files` are written into
// the project before it opens (a plugin, say).
async function withProject(
  fn: () => Promise<void>,
  extra: Record<string, unknown> = {},
  files: Record<string, string> = {},
) {
  await using project = await tmpdir({
    git: true,
    init: async (dir) => {
      for (const [name, body] of Object.entries(files)) await Bun.write(path.join(dir, name), body)
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          enabled_providers: ["anthropic"],
          model: `anthropic/${MODEL}`,
          provider: { anthropic: { options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` } } },
          ...Object.fromEntries(
            Object.entries(extra).map(([key, value]) => [key, typeof value === "function" ? value(dir) : value]),
          ),
        }),
      )
    },
  })
  await Instance.provide({ directory: project.path, fn })
}

const asked = {
  questions: [
    {
      question: "Deploy where?",
      header: "Target",
      options: [
        { label: "staging", description: "the test box" },
        { label: "production", description: "the real one" },
      ],
    },
  ],
}
const chose =
  "[Your question tool call, answered in the picker. That was the right way to ask.]\nYou asked: Deploy where?\nOptions: staging, production\nI chose: staging"
const unasked = (reason: string) =>
  `[Your question tool call, not answered: ${reason}. That was the right way to ask.]\nYou asked: Deploy where?\nOptions: staging, production`
const nudge =
  "<!-- question-tool -->\n<system-reminder>\nAsk any question with a fixed set of answers by calling the question tool; a question written as text shows the user no picker.\n</system-reminder>"

function say(sessionID: string, words: string) {
  return SessionPrompt.prompt({
    sessionID,
    agent: "build",
    model: Provider.DEFAULT,
    variant: Provider.DEFAULT,
    parts: [{ type: "text", text: words }],
  })
}

// Every text block the request sent, by role, from the last assistant turn on.
function tail(body: Record<string, any>) {
  const messages = body.messages as { role: string; content: string | { type: string; text?: string }[] }[]
  const from = messages.findLastIndex((m) => m.role === "assistant")
  return messages.slice(from).map((m) => ({
    role: m.role,
    blocks:
      typeof m.content === "string"
        ? [{ type: "text", text: m.content }]
        : m.content.map((c) => ({ type: c.type, text: c.text })),
  }))
}

async function question(sessionID: string) {
  const messages = await Session.messages({ sessionID })
  return messages.flatMap((m) => m.parts).find((p): p is any => p.type === "tool" && p.tool === "question")
}

// Answers the question once its part is running, which is how long a person
// takes at least. The whole reply arrives at once here, so the tool can ask
// before the processor has written the part. Resolves with the running part.
function when(sessionID: string, act: (requestID: string) => Promise<unknown>) {
  const seen = Promise.withResolvers<any>()
  const off = Bus.subscribe(Question.Event.Asked, async (event) => {
    const deadline = Date.now() + 5000
    while ((await question(sessionID))?.state.status !== "running" && Date.now() < deadline) await Bun.sleep(10)
    seen.resolve(await question(sessionID))
    await act(event.properties.id)
  })
  return { seen: seen.promise, off }
}

// The question's stored text part (same id as its tool part) and the message
// after the one that holds it.
async function stored(sessionID: string, partID: string) {
  const messages = await Session.messages({ sessionID })
  const at = messages.findIndex((m) => m.parts.some((p) => p.id === partID))
  return { part: messages[at]?.parts.find((p) => p.id === partID) as any, after: messages[at + 1] }
}

describe("a question is stored and sent as the user's own words once it is answered", () => {
  test("an answer replaces the tool part with an empty record and adds the user's message carrying the question", async () => {
    await withProject(async () => {
      const session = await Session.create({})
      state.queue.push(
        () => reply([text("One thing first."), toolUse("question", asked)], "tool_use"),
        () => reply([text("Deploying to staging.")], "end_turn"),
      )
      const answer = when(session.id, (id) => Question.reply({ requestID: id, answers: [["staging"]] }))
      await say(session.id, "deploy it")
      answer.off()
      const waiting = await answer.seen
      expect(waiting.state).toMatchObject({ status: "running", metadata: { plain: true } })

      const { part, after } = await stored(session.id, waiting.id)
      expect(part).toMatchObject({
        type: "text",
        text: "",
        synthetic: true,
        question: { callID: "toolu_q", answers: [["staging"]] },
      })
      expect(part.question.questions[0].options[1]).toEqual({ label: "production", description: "the real one" })
      expect(after.info.role).toBe("user")
      expect(after.parts.map((p: any) => [p.text, p.synthetic])).toEqual([
        [chose, undefined],
        [nudge, true],
      ])
      expect(await question(session.id)).toBeUndefined()

      expect(state.bodies).toHaveLength(2)
      expect(tail(state.bodies[0])).toEqual([
        {
          role: "user",
          blocks: [
            { type: "text", text: nudge },
            { type: "text", text: "deploy it" },
          ],
        },
      ])
      expect(tail(state.bodies[1])).toEqual([
        { role: "assistant", blocks: [{ type: "text", text: "One thing first." }] },
        {
          role: "user",
          blocks: [
            { type: "text", text: nudge },
            { type: "text", text: chose },
          ],
        },
      ])
      expect(JSON.stringify(state.bodies[1].messages)).not.toContain("toolu_q")
    })
  }, 60_000)

  test("a dismissal is written as the user's message and the turn carries on to answer it", async () => {
    await withProject(async () => {
      const session = await Session.create({})
      state.queue.push(
        () => reply([toolUse("question", asked)], "tool_use"),
        () => reply([text("Understood, I will not deploy.")], "end_turn"),
      )
      const dismiss = when(session.id, (id) => Question.reject(id))
      await say(session.id, "deploy it")
      dismiss.off()
      const note = unasked("the user dismissed it")

      const { part, after } = await stored(session.id, (await dismiss.seen).id)
      expect(part).toMatchObject({ type: "text", text: "", question: { error: "the user dismissed it" } })
      expect(after.parts.map((p: any) => p.text)).toEqual([note, nudge])
      expect(state.bodies).toHaveLength(2)
      // The step held only the question, so nothing of the model's turn is
      // left and the answer joins the prompt as one user message.
      expect(tail(state.bodies[1])).toEqual([
        {
          role: "user",
          blocks: [
            { type: "text", text: nudge },
            { type: "text", text: "deploy it" },
            { type: "text", text: nudge },
            { type: "text", text: note },
          ],
        },
      ])
    })
  }, 60_000)

  test("Esc while a question waits writes it down as unanswered and the session stays stopped", async () => {
    await withProject(async () => {
      const session = await Session.create({})
      state.queue.push(() => reply([toolUse("question", asked)], "tool_use"))
      const esc = when(session.id, () => Session.interrupt(session.id))
      await say(session.id, "deploy it").catch(() => undefined)
      esc.off()
      // The cancel answers the prompt at once; the step unwinds after it.
      const id = (await esc.seen).id
      const deadline = Date.now() + 5000
      while ((await stored(session.id, id)).part?.type !== "text" && Date.now() < deadline) await Bun.sleep(20)

      const { part, after } = await stored(session.id, id)
      expect(part).toMatchObject({ type: "text", text: "", question: { error: "the turn was stopped" } })
      expect(after.parts.map((p: any) => p.text)).toEqual([unasked("the turn was stopped")])
      expect((await Session.get(session.id)).time.stopped).toBeGreaterThanOrEqual(after.info.time.created)
      expect(state.bodies).toHaveLength(1)
    })
  }, 60_000)

  test("Stop while a question waits writes it down as unanswered and nothing wakes the session", async () => {
    await withProject(async () => {
      const session = await Session.create({})
      state.queue.push(() => reply([toolUse("question", asked)], "tool_use"))
      const stop = when(session.id, () => Session.stop({ sessionID: session.id }))
      await say(session.id, "deploy it").catch(() => undefined)
      stop.off()
      const id = (await stop.seen).id
      const deadline = Date.now() + 5000
      while ((await stored(session.id, id)).part?.type !== "text" && Date.now() < deadline) await Bun.sleep(20)

      const { part, after } = await stored(session.id, id)
      expect(part).toMatchObject({ type: "text", text: "", question: { error: "the turn was stopped" } })
      expect(after.parts.map((p: any) => p.text)).toEqual([unasked("the turn was stopped")])
      expect((await Session.get(session.id)).time.stopped).toBeGreaterThanOrEqual(after.info.time.created)
      expect(await Sessions.listUnanswered(Date.now() + 1)).not.toContainEqual(
        expect.objectContaining({ id: session.id }),
      )
      expect(state.bodies).toHaveLength(1)
    })
  }, 60_000)

  test("several questions list each one with its answer", async () => {
    await withProject(async () => {
      const session = await Session.create({})
      const two = {
        questions: [
          asked.questions[0],
          { question: "Notify?", header: "Notify", options: [{ label: "yes", description: "tell the team" }] },
        ],
      }
      state.queue.push(
        () => reply([toolUse("question", two)], "tool_use"),
        () => reply([text("Done.")], "end_turn"),
      )
      const answer = when(session.id, (id) => Question.reply({ requestID: id, answers: [["staging"], ["yes"]] }))
      await say(session.id, "deploy it")
      answer.off()
      expect(tail(state.bodies[1])).toEqual([
        {
          role: "user",
          blocks: [
            { type: "text", text: nudge },
            { type: "text", text: "deploy it" },
            { type: "text", text: nudge },
            { type: "text", text: `${chose}\n\nYou asked: Notify?\nOptions: yes\nI chose: yes` },
          ],
        },
      ])
    })
  }, 60_000)

  test("a malformed question keeps the tool shape so the model sees its error", async () => {
    await withProject(async () => {
      const session = await Session.create({})
      state.queue.push(
        () => reply([toolUse("question", { questions: '[{"question":"Deploy?"}]' })], "tool_use"),
        () => reply([text("Let me ask properly.")], "end_turn"),
      )
      await say(session.id, "deploy it")
      expect((await question(session.id)).state.status).toBe("error")
      expect(state.bodies).toHaveLength(2)
      expect(JSON.stringify(state.bodies[1].messages)).toContain("toolu_q")
    })
  }, 60_000)
})

// The last request's blocks as [role, type] pairs, with any tool_use or
// tool_result named by its call id.
function shape(body: Record<string, any>) {
  return (body.messages as { role: string; content: string | Record<string, any>[] }[]).flatMap((m) =>
    typeof m.content === "string"
      ? [[m.role, "text"]]
      : m.content.map((c) => [m.role, c.type === "text" ? "text" : `${c.type}:${c.id ?? c.tool_use_id}`]),
  )
}

// The answers the question tool is waiting on for `sessionID`, once `count` are.
async function pending(sessionID: string, count: number) {
  const deadline = Date.now() + 5000
  const mine = async () => (await Question.list()).filter((q) => q.sessionID === sessionID)
  while ((await mine()).length < count && Date.now() < deadline) await Bun.sleep(10)
  return mine()
}

describe("only a question that was asked is written down", () => {
  test("a question the tool's own schema rejects keeps the tool shape", async () => {
    await withProject(async () => {
      const session = await Session.create({})
      const headless = { questions: [{ question: "Deploy?", options: [{ label: "staging", description: "s" }] }] }
      state.queue.push(
        () => reply([toolUse("question", headless)], "tool_use"),
        () => reply([text("Let me ask properly.")], "end_turn"),
      )
      await say(session.id, "deploy it")
      const part = await question(session.id)
      expect(part.state.status).toBe("error")
      expect(part.state.metadata?.plain).toBeUndefined()
      expect(shape(state.bodies[1])).toEqual([
        ["user", "text"],
        ["user", "text"],
        ["assistant", "tool_use:toolu_q"],
        ["user", "tool_result:toolu_q"],
      ])
    })
  }, 60_000)

  test("a question whose permission is refused keeps the tool shape", async () => {
    await withProject(
      async () => {
        const session = await Session.create({})
        state.queue.push(
          () => reply([toolUse("question", asked)], "tool_use"),
          () => reply([text("Understood.")], "end_turn"),
        )
        const off = Bus.subscribe(PermissionNext.Event.Asked, (event) =>
          PermissionNext.reply({ requestID: event.properties.id, reply: "reject" }),
        )
        await say(session.id, "deploy it").catch(() => undefined)
        off()
        await say(session.id, "try again")
        const part = await question(session.id)
        expect(part.state.status).toBe("error")
        expect(part.state.metadata?.plain).toBeUndefined()
        const last = state.bodies.at(-1)!
        expect(shape(last).slice(0, 4)).toEqual([
          ["user", "text"],
          ["user", "text"],
          ["assistant", "tool_use:toolu_q"],
          ["user", "tool_result:toolu_q"],
        ])
        expect(JSON.stringify(last.messages)).not.toContain("[Your question tool call")
      },
      { permission: { question: "ask" } },
    )
  }, 60_000)

  test("a server dispose leaves the question for Recovery: no note, no second request", async () => {
    await withProject(async () => {
      const session = await Session.create({})
      state.queue.push(() => reply([toolUse("question", asked)], "tool_use"))
      const dispose = when(session.id, () => Instance.dispose())
      await say(session.id, "deploy it").catch(() => undefined)
      dispose.off()
      await dispose.seen
      await Bun.sleep(300)
      const messages = await Session.messages({ sessionID: session.id })
      expect(messages.map((m) => m.info.role)).toEqual(["user", "assistant"])
      expect(messages[1].parts.some((p) => p.type === "text" && p.question)).toBe(false)
      expect(state.bodies).toHaveLength(1)
      expect((await Sessions.read(session.id)).turn?.boot).toBe(0)
    })
  }, 60_000)
})

describe("a written-down question keeps its place in the transcript", () => {
  test("a note never lands after a newer prompt: the write is refused and the stop is not moved", async () => {
    await withProject(async () => {
      const session = await Session.create({})
      const model = { providerID: "anthropic", modelID: MODEL }
      const opener = await Session.updateMessage({
        id: Identifier.ascending("message"),
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model,
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: opener.id,
        sessionID: session.id,
        type: "text",
        text: "deploy it",
      })
      const step = await Session.updateMessage({
        id: Identifier.ascending("message"),
        sessionID: session.id,
        role: "assistant",
        parentID: opener.id,
        mode: "build",
        agent: "build",
        path: { cwd: Instance.directory, root: Instance.worktree },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: MODEL,
        providerID: "anthropic",
        time: { created: Date.now() },
      })
      const part = (await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: step.id,
        sessionID: session.id,
        type: "tool",
        callID: "toolu_q",
        tool: "question",
        state: { status: "running", input: asked, time: { start: Date.now() }, metadata: { plain: true } },
      })) as any
      await Session.update(session.id, (draft) => void (draft.time.stopped = Date.now()))
      const stopped = (await Session.get(session.id)).time.stopped
      const newer = await Session.updateMessage({
        id: Identifier.ascending("message"),
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() + 1 },
        agent: "build",
        model,
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: newer.id,
        sessionID: session.id,
        type: "text",
        text: "actually, do something else",
      })

      const written = await SessionPrompt.transcribe({
        part,
        opener: opener as any,
        reason: "the turn was stopped",
        halted: true,
      })

      expect(written).toBeUndefined()
      const messages = await Session.messages({ sessionID: session.id })
      expect(messages.map((m) => m.info.id)).toEqual([opener.id, step.id, newer.id])
      expect(messages[1].parts[0].type).toBe("tool")
      expect((await Session.get(session.id)).time.stopped).toBe(stopped)
    })
  }, 60_000)

  // A message the step never saw can sort before it: its id is minted before
  // the step's (by a client's clock, or before its attachments resolve) and it
  // is written after. The claim must still see it.
  for (const outcome of ["answered", "halted"] as const)
    test(`a note or answer is refused behind a message the step never saw, whatever its id (${outcome})`, async () => {
      await withProject(async () => {
        const session = await Session.create({})
        const model = { providerID: "anthropic", modelID: MODEL }
        const opener = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model,
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: opener.id,
          sessionID: session.id,
          type: "text",
          text: "deploy it",
        })
        const early = Identifier.ascending("message")
        const step = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "assistant",
          parentID: opener.id,
          mode: "build",
          agent: "build",
          path: { cwd: Instance.directory, root: Instance.worktree },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: MODEL,
          providerID: "anthropic",
          time: { created: Date.now() },
        })
        const part = (await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: step.id,
          sessionID: session.id,
          type: "tool",
          callID: "toolu_q",
          tool: "question",
          state: { status: "running", input: asked, time: { start: Date.now() }, metadata: { plain: true } },
        })) as any
        await Session.updateMessage({
          id: early,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model,
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: early,
          sessionID: session.id,
          type: "text",
          text: "actually, do something else",
        })
        expect(early < step.id).toBe(true)

        const written = await SessionPrompt.transcribe({
          part,
          opener: opener as any,
          ...(outcome === "answered"
            ? { answers: [["staging"]] }
            : { reason: "the turn was stopped", halted: true }),
        })

        expect(written).toBeUndefined()
        const messages = await Session.messages({ sessionID: session.id })
        expect(messages).toHaveLength(3)
        expect(messages.find((m) => m.info.id === step.id)!.parts[0].type).toBe("tool")
      })
    }, 60_000)

  // A hook that throws after the write committed: the write stands, so the
  // stop still moves past the note and the UI still hears of the new part.
  for (const halt of ["Esc", "Stop"] as const)
    test(`a throw after a halted note is written still stamps the stop past it and publishes the part (${halt})`, async () => {
      const plugin = `export default async () => ({
        "chat.message": async (_input, output) => {
          if (JSON.stringify(output).includes('"callID"')) throw new Error("hook failed")
        },
      })`
      await withProject(
        async () => {
          const session = await Session.create({})
          state.queue.push(() => reply([toolUse("question", asked)], "tool_use"))
          const published: string[] = []
          const off = Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
            if (event.properties.part.type === "text" && event.properties.part.question)
              published.push(event.properties.part.id)
          })
          const stop = when(session.id, () =>
            halt === "Esc" ? Session.interrupt(session.id) : Session.stop({ sessionID: session.id }),
          )
          await say(session.id, "deploy it").catch(() => undefined)
          stop.off()
          const id = (await stop.seen).id
          const deadline = Date.now() + 5000
          while ((await stored(session.id, id)).part?.type !== "text" && Date.now() < deadline) await Bun.sleep(20)
          await Bun.sleep(200)
          off()

          const { part, after } = await stored(session.id, id)
          expect(part.type).toBe("text")
          expect((await Session.get(session.id)).time.stopped).toBeGreaterThanOrEqual(after.info.time.created)
          expect(published).toContain(id)
        },
        { plugin: (dir: string) => [`file://${path.join(dir, "hook.ts")}`] },
        { "hook.ts": plugin },
      )
    }, 60_000)

  test("two questions in one step are each answered by name, whatever order they are answered in", async () => {
    await withProject(async () => {
      const session = await Session.create({})
      const notify = {
        questions: [{ question: "Notify?", header: "Notify", options: [{ label: "yes", description: "tell the team" }] }],
      }
      state.queue.push(
        () => reply([toolUse("question", asked, "toolu_q"), toolUse("question", notify, "toolu_r")], "tool_use"),
        () => reply([text("Done.")], "end_turn"),
      )
      const turn = say(session.id, "deploy it")
      const waiting = await pending(session.id, 2)
      const byQuestion = (q: string) => waiting.find((w) => w.questions[0].question === q)!.id
      await Question.reply({ requestID: byQuestion("Notify?"), answers: [["yes"]] })
      await Question.reply({ requestID: byQuestion("Deploy where?"), answers: [["staging"]] })
      await turn
      const users = tail(state.bodies[1]).filter((m) => m.role === "user")
      expect(users.flatMap((m) => m.blocks.map((b) => b.text)).filter((t) => t !== nudge)).toEqual([
        "deploy it",
        "[Your question tool call, answered in the picker. That was the right way to ask.]\nYou asked: Notify?\nOptions: yes\nI chose: yes",
        chose,
      ])
    })
  }, 60_000)

  test("a failure after the answer is written does not write it a second time", async () => {
    const plugin = `export default async () => ({
      "chat.message": async (_input, output) => {
        if (JSON.stringify(output).includes('"callID"')) throw new Error("hook failed")
      },
    })`
    await withProject(
      async () => {
        const session = await Session.create({})
        state.queue.push(
          () => reply([toolUse("question", asked)], "tool_use"),
          () => reply([text("Deploying.")], "end_turn"),
        )
        const answer = when(session.id, (id) => Question.reply({ requestID: id, answers: [["staging"]] }))
        await say(session.id, "deploy it")
        answer.off()
        const { part } = await stored(session.id, (await answer.seen).id)
        expect(part.type).toBe("text")
        const sent = JSON.stringify(state.bodies[1].messages)
        expect(sent.split("I chose: staging").length - 1).toBe(1)
      },
      { plugin: (dir: string) => [`file://${path.join(dir, "hook.ts")}`] },
      { "hook.ts": plugin },
    )
  }, 60_000)
})

describe("an answer is not read as the user's prompt", () => {
  test("the title reads the typed prompts, not answers or notes", () => {
    const user = (id: string, text: string, record?: MessageV2.QuestionRecord) =>
      ({
        info: { id, sessionID: "s", role: "user", time: { created: 1 }, agent: "build", model: { providerID: "anthropic", modelID: MODEL } },
        parts: [{ id: `${id}-p`, sessionID: "s", messageID: id, type: "text", text, ...(record && { question: record }) }],
      }) as MessageV2.WithParts
    const record = { callID: "toolu_q", questions: asked.questions, error: "the user dismissed it" }
    expect(
      SessionPrompt.titleInput([
        user("m1", "deploy it"),
        user("m2", "[The question was not answered: the user dismissed it]", record),
        user("m3", "then write the notes"),
      ]),
    ).toBe("deploy it\nthen write the notes")
  })

  test("the opener's own system text still reaches the request after an answer", async () => {
    await withProject(async () => {
      const session = await Session.create({})
      state.queue.push(
        () => reply([toolUse("question", asked)], "tool_use"),
        () => reply([text("Deploying.")], "end_turn"),
      )
      const answer = when(session.id, (id) => Question.reply({ requestID: id, answers: [["staging"]] }))
      await SessionPrompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: Provider.DEFAULT,
        variant: Provider.DEFAULT,
        system: "CUSTOM-SYSTEM-MARKER",
        parts: [{ type: "text", text: "deploy it" }],
      })
      answer.off()
      expect(state.bodies.map((body) => JSON.stringify(body.system).includes("CUSTOM-SYSTEM-MARKER"))).toEqual([
        true,
        true,
      ])
    })
  }, 60_000)

  test("an @agent turn keeps its agent check bypass after an answer", async () => {
    await withProject(
      async () => {
        const session = await Session.create({})
        // A known toolset, or the tool returns before its agent check.
        const launch = { description: "look", prompt: "look around", subagent_type: "explore", toolset: "explore" }
        state.queue.push(
          () => reply([toolUse("question", asked)], "tool_use"),
          () => reply([toolUse("agent", launch, "toolu_a")], "tool_use"),
          () => reply([text("Done.")], "end_turn"),
        )
        const asks: string[] = []
        const off = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
          asks.push(event.properties.permission)
          return PermissionNext.reply({ requestID: event.properties.id, reply: "reject" })
        })
        const answer = when(session.id, (id) => Question.reply({ requestID: id, answers: [["staging"]] }))
        await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: Provider.DEFAULT,
          variant: Provider.DEFAULT,
          parts: [
            { type: "text", text: "deploy it with @explore" },
            { type: "agent", name: "explore" },
          ],
        }).catch(() => undefined)
        answer.off()
        off()
        expect(asks).not.toContain("agent")
      },
      { permission: { agent: "ask" } },
    )
  }, 60_000)

  test("pruning counts turns, not answers", async () => {
    await withProject(async () => {
      const session = await Session.create({})
      const model = { providerID: "anthropic", modelID: MODEL }
      const user = async (words: string, record?: MessageV2.QuestionRecord) => {
        const info = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model,
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: info.id,
          sessionID: session.id,
          type: "text",
          text: words,
          ...(record && { question: record }),
        })
        return info
      }
      const step = async (parentID: string, output?: string) => {
        const info = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
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
        if (output)
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: info.id,
            sessionID: session.id,
            type: "tool",
            callID: "toolu_b",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "cat big" },
              output,
              title: "cat",
              metadata: {},
              time: { start: 1, end: 2 },
            },
          })
        return info
      }
      const u0 = await user("first")
      const a0 = await step(u0.id, "x".repeat(300_000))
      const u1 = await user("second")
      await step(u1.id)
      const r1 = await user("staging", { callID: "toolu_q", questions: asked.questions, answers: [["staging"]] })
      await step(r1.id)

      await SessionCompaction.prune({ sessionID: session.id })

      const output = (await Session.messages({ sessionID: session.id }))
        .find((m) => m.info.id === a0.id)!
        .parts.find((p) => p.type === "tool") as any
      expect(output.state.time.compacted).toBeUndefined()
    })
  }, 60_000)
})
