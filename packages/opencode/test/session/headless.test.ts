import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { HeadlessAgent } from "../../src/session/headless"
import { Session } from "../../src/session"
import { Sessions } from "../../src/storage/sessions"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { BackgroundProcess } from "../../src/background/process"
import { GlobalBus } from "../../src/bus/global"
import { Log } from "../../src/util/log"
import { Recovery } from "../../src/session/recovery"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

type Capture = { body: Record<string, any> }

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  queue: [] as Array<{ response: () => Response; resolve: (value: Capture) => void }>,
  captured: [] as Capture[],
}

function respond(response: () => Response) {
  return new Promise<Capture>((resolve) => state.queue.push({ response, resolve }))
}

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Record<string, any>
      state.captured.push({ body })
      const next = state.queue.shift()
      if (!next) return reply([text("fallback")], "end_turn")
      next.resolve({ body })
      return next.response()
    },
  })
})

beforeEach(() => {
  state.queue.length = 0
  state.captured.length = 0
  // serve opens this gate after its boot grace; a test opens it directly.
  Recovery.start()
})

afterAll(() => {
  Recovery.stop()
  state.server?.stop()
})

const MODEL = "claude-3-5-sonnet-20241022"

function sse(chunks: unknown[]) {
  const payload = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n") + "\n\n"
  return new Response(payload, { status: 200, headers: { "Content-Type": "text/event-stream" } })
}

function text(value: string) {
  return [
    { type: "content_block_start", content_block: { type: "text", text: "" } },
    { type: "content_block_delta", delta: { type: "text_delta", text: value } },
    { type: "content_block_stop" },
  ]
}

function toolUse(name: string, input: unknown) {
  return [
    { type: "content_block_start", content_block: { type: "tool_use", id: "toolu_1", name, input: {} } },
    { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "content_block_stop" },
  ]
}

function reply(blocks: Record<string, any>[][], stop: string) {
  const indexed = blocks.flatMap((block, index) => block.map((chunk) => ({ ...chunk, index })))
  return sse([
    {
      type: "message_start",
      message: {
        id: "msg-1",
        model: MODEL,
        usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    },
    ...indexed,
    { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 6 } },
    { type: "message_stop" },
  ])
}

// A reply that starts streaming and never ends.
function endless(streams: ReadableStreamDefaultController<Uint8Array>[]) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        streams.push(controller)
        const chunk = { type: "message_start", message: { id: "msg-1", model: MODEL, usage: { input_tokens: 1 } } }
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`))
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  )
}

// A stream the aborted request already cancelled refuses a close.
function close(streams: ReadableStreamDefaultController<Uint8Array>[]) {
  for (const stream of streams)
    void Promise.resolve()
      .then(() => stream.close())
      .catch(() => {})
}

async function withProject(fn: (dir: string) => Promise<void>, permission: Record<string, string> = { bash: "ask" }) {
  const server = state.server!
  await using project = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          enabled_providers: ["anthropic"],
          model: `anthropic/${MODEL}`,
          provider: { anthropic: { options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1` } } },
          permission,
        }),
      )
      await Bun.write(path.join(dir, "AGENTS.md"), "PROJECT-RULES-MUST-NOT-LEAK")
      await Bun.write(path.join(dir, "notes.txt"), "the answer is 42")
    },
  })
  await Instance.provide({ directory: project.path, fn: () => fn(project.path) })
}

function toolNames(capture: Capture) {
  return (capture.body.tools ?? []).map((t: { name: string }) => t.name)
}

describe("HeadlessAgent.run", () => {
  test("runs the agent's tool loop bare, returns only the final text, and removes the session", async () => {
    await withProject(async (dir) => {
      const first = respond(() => reply([toolUse("read", { filePath: path.join(dir, "notes.txt") })], "tool_use"))
      const second = respond(() => reply([text("It says 42.")], "end_turn"))

      const outcome = await HeadlessAgent.run({
        model: "default",
        variant: "default",
        agent: "build",
        prompt: "What does notes.txt say?",
      })
      const [call1, call2] = [await first, await second]

      expect(outcome).toMatchObject({
        result: "It says 42.",
        finish: "stop",
        num_turns: 2,
        usage: { input: 40, output: 12, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        permission_denials: [],
        model: `anthropic/${MODEL}`,
        is_error: false,
        errors: [],
      })
      expect(outcome.session_id).toBeUndefined()
      expect(JSON.stringify(call1.body)).not.toContain("PROJECT-RULES-MUST-NOT-LEAK")
      expect(toolNames(call1)).toContain("read")
      expect(toolNames(call1)).not.toContain("skill")
      expect(toolNames(call1)).not.toContain("mcp_search")
      expect(toolNames(call1)).not.toContain("agent")
      expect(toolNames(call1)).not.toContain("question")
      expect(JSON.stringify(call2.body)).toContain("the answer is 42")
      expect(state.captured.length).toBe(2)

      const remaining = []
      for await (const session of Session.list()) remaining.push(session.id)
      expect(remaining).toEqual([])
    })
  }, 60_000)

  test("denies a permission prompt instead of waiting, reports it, and the agent carries on", async () => {
    await withProject(async () => {
      respond(() => reply([toolUse("bash", { command: "rm -rf build", description: "clean" })], "tool_use"))
      const second = respond(() => reply([text("Could not run it.")], "end_turn"))

      const outcome = await HeadlessAgent.run({
        model: "default",
        variant: "default",
        agent: "build",
        prompt: "Clean the build dir.",
      })
      const followUp = JSON.stringify((await second).body)

      expect(outcome.result).toBe("Could not run it.")
      expect(outcome.is_error).toBe(false)
      expect(outcome.permission_denials).toEqual([{ permission: "bash", patterns: ["rm -rf build"], metadata: {} }])
      expect(followUp).toContain("prevents you from using this specific tool call")
    })
  }, 60_000)

  test("loads project instructions when bare is false, and keeps the session when asked", async () => {
    await withProject(async () => {
      const first = respond(() => reply([text("ok")], "end_turn"))
      const outcome = await HeadlessAgent.run({
        model: "default",
        variant: "default",
        agent: "build",
        prompt: "hi",
        bare: false,
        keep: true,
      })

      expect(JSON.stringify((await first).body)).toContain("PROJECT-RULES-MUST-NOT-LEAK")
      expect(outcome.session_id).toStartWith("ses_")
      const kept = await Session.get(outcome.session_id!)
      expect(kept).toMatchObject({ ephemeral: true })
      expect(kept.bare).toBeUndefined()
      expect(kept.title).toBe("headless build")
    })
  }, 60_000)

  test("waits for a bash job that outlives the turn, and returns the answer written after it lands", async () => {
    await withProject(
      async (dir) => {
        // serve starts this in production; a settled job pokes recovery, which
        // delivers the result into its session and wakes the turn.
        const { BackgroundOrchestrator } = await import("../../src/background/orchestrator")
        BackgroundOrchestrator.init()
        const release = path.join(dir, "release")
        const command = `while [ ! -f ${release} ]; do sleep 0.1; done; echo JOB-DONE-9913`
        respond(() => reply([toolUse("bash", { command, description: "slow step" })], "tool_use"))
        const waiting = respond(() => reply([text("Started it, waiting.")], "end_turn"))
        // The run starts waiting when that turn ends. Releasing the job midway
        // between the safety net's ticks leaves the next one seconds away, so
        // only the pushed turn end can return the run promptly.
        void waiting.then(() => Bun.sleep(HeadlessAgent.NET_MS * 1.5)).then(() => Bun.write(release, ""))
        const woken = respond(() => reply([text("The job printed JOB-DONE-9913.")], "end_turn")).then((wake) => ({
          wake,
          at: Date.now(),
        }))

        const outcome = await HeadlessAgent.run({
          model: "default",
          variant: "default",
          agent: "build",
          prompt: "Run the slow step.",
        })
        const returned = Date.now()

        expect(outcome).toMatchObject({
          result: "The job printed JOB-DONE-9913.",
          num_turns: 3,
          permission_denials: [],
          is_error: false,
        })
        const { wake, at } = await woken
        expect(returned - at).toBeLessThan(1000)
        expect(JSON.stringify(wake.body)).toContain("JOB-DONE-9913")
      },
      { bash: "allow" },
    )
  }, 120_000)

  test("sweep removes headless sessions created before the cutoff and leaves ordinary sessions alone", async () => {
    await withProject(async () => {
      respond(() => reply([text("ok")], "end_turn"))
      const kept = await HeadlessAgent.run({
        model: "default",
        variant: "default",
        agent: "build",
        prompt: "hi",
        keep: true,
      })
      const ordinary = await Session.create({})
      const cutoff = Date.now() + 1
      const survivor = await Sessions.listEphemeral(cutoff).then((all) => all.map((s) => s.id))
      expect(survivor).toContain(kept.session_id!)

      await HeadlessAgent.sweep(cutoff)

      expect(await Sessions.listEphemeral(cutoff)).toEqual([])
      await expect(Sessions.read(kept.session_id!)).rejects.toThrow()
      expect((await Sessions.read(ordinary.id)).id).toBe(ordinary.id)
    })
  }, 60_000)

  test("a run past its timeout is stopped and reports the timeout", async () => {
    await withProject(async (dir) => {
      const streams: ReadableStreamDefaultController<Uint8Array>[] = []
      const started = respond(() => endless(streams))
      const before = Date.now()

      try {
        const outcome = await HeadlessAgent.run({
          model: "default",
          variant: "default",
          agent: "build",
          prompt: "hang",
          timeoutMs: 1500,
          keep: true,
        })
        await started

        expect(outcome.is_error).toBe(true)
        expect(outcome.errors).toEqual([`headless: build in ${dir}: timed out after 1500ms`])
        const stopped = (await Session.get(outcome.session_id!)).time.stopped!
        expect(stopped >= before + 1500 && stopped <= Date.now()).toBe(true)
      } finally {
        close(streams)
      }
    })
  }, 60_000)

  test("a caller that disconnects as the prompt is written stops the turn it opens", async () => {
    await withProject(async (dir) => {
      const streams: ReadableStreamDefaultController<Uint8Array>[] = []
      respond(() => endless(streams))
      const caller = new AbortController()
      const written = (event: { payload: { type: string; properties: { info?: { role?: string } } } }) => {
        if (event.payload.type === "message.updated" && event.payload.properties.info?.role === "user") caller.abort()
      }
      GlobalBus.on("event", written)

      try {
        const outcome = await HeadlessAgent.run(
          { model: "default", variant: "default", agent: "build", prompt: "hang", timeoutMs: 20_000 },
          caller.signal,
        )
        expect(outcome.errors).toEqual([`headless: build in ${dir}: the caller disconnected`])
      } finally {
        GlobalBus.off("event", written)
        close(streams)
      }
    })
  }, 60_000)

  test("a caller that disconnects while the run waits on its job stops the run, kills the job, and removes the session", async () => {
    await withProject(
      async (dir) => {
        const { BackgroundOrchestrator } = await import("../../src/background/orchestrator")
        BackgroundOrchestrator.init()
        const pidfile = path.join(dir, "job.pid")
        const command = `sleep 1000 & echo $! > ${pidfile}; wait`
        respond(() => reply([toolUse("bash", { command, description: "endless step" })], "tool_use"))
        const waiting = respond(() => reply([text("Started it, waiting.")], "end_turn"))
        const caller = new AbortController()
        void waiting.then(() => Bun.sleep(1000)).then(() => caller.abort())

        const outcome = await HeadlessAgent.run(
          { model: "default", variant: "default", agent: "build", prompt: "Run the endless step.", timeoutMs: 20_000 },
          caller.signal,
        )

        expect(outcome).toMatchObject({
          is_error: true,
          errors: [`headless: build in ${dir}: the caller disconnected`],
        })
        expect(await BackgroundProcess.inspect(Number(await Bun.file(pidfile).text()))).toBeUndefined()
        const remaining = []
        for await (const session of Session.list()) remaining.push(session.id)
        expect(remaining).toEqual([])
        expect(state.captured.length).toBe(2)
      },
      { bash: "allow" },
    )
  }, 60_000)

  test("a caller already gone before the prompt starts no turn", async () => {
    await withProject(async (dir) => {
      const outcome = await HeadlessAgent.run(
        { model: "default", variant: "default", agent: "build", prompt: "hi" },
        AbortSignal.abort(),
      )
      expect(outcome).toMatchObject({ is_error: true, errors: [`headless: build in ${dir}: the caller disconnected`] })
      expect(state.captured.length).toBe(0)
      const remaining = []
      for await (const session of Session.list()) remaining.push(session.id)
      expect(remaining).toEqual([])
    })
  }, 60_000)

  test("rejects an unknown agent without creating a session", async () => {
    await withProject(async () => {
      const outcome = await HeadlessAgent.run({ model: "default", variant: "default", agent: "nope", prompt: "hi" })
      expect(outcome).toMatchObject({ is_error: true, errors: ['headless: unknown agent "nope"'] })
      expect(state.captured.length).toBe(0)
    })
  }, 60_000)

  test("POST /agent/headless returns the result, hides the run from GET /session, and rejects a body without a prompt", async () => {
    await withProject(async (dir) => {
      const app = Server.App()
      const query = `?directory=${encodeURIComponent(dir)}`
      respond(() => reply([text("via http")], "end_turn"))

      const ok = await app.request(`/agent/headless${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "build", prompt: "hi", keep: true, model: "default", variant: "default" }),
      })
      expect(ok.status).toBe(200)
      expect(await ok.json()).toMatchObject({ result: "via http", is_error: false })

      const listed = await app.request(`/session${query}`)
      expect(await listed.json()).toEqual([])

      const bad = await app.request(`/agent/headless${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "build", model: "default", variant: "default" }),
      })
      expect(bad.status).toBe(400)

      const unchosen = await app.request(`/agent/headless${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "build", prompt: "hi" }),
      })
      expect(unchosen.status).toBe(400)
    })
  }, 60_000)
})
