import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { Oneshot } from "../../src/session/oneshot"
import { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

type Body = { system?: unknown[]; messages: unknown[]; tools?: unknown; thinking?: unknown }

type Capture = { headers: Headers; body: Body }

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  queue: [] as Array<{ response: () => Response; resolve: (value: Capture) => void }>,
}

function respond(response: () => Response) {
  return new Promise<Capture>((resolve) => state.queue.push({ response, resolve }))
}

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const next = state.queue.shift()
      if (!next) return new Response("unexpected request", { status: 500 })
      next.resolve({ headers: req.headers, body: (await req.json()) as Body })
      return next.response()
    },
  })
})

beforeEach(() => {
  state.queue.length = 0
})

afterAll(() => {
  state.server?.stop()
})

function sse(chunks: unknown[]) {
  const payload = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n") + "\n\n"
  return new Response(payload, { status: 200, headers: { "Content-Type": "text/event-stream" } })
}

const MODEL = "claude-3-5-sonnet-20241022"
const start = {
  type: "message_start",
  message: {
    id: "msg-1",
    model: MODEL,
    usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  },
}
const stop = (reason: string, output: number) => [
  { type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: output } },
  { type: "message_stop" },
]

function textReply(text: string) {
  return sse([
    start,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    ...stop("end_turn", 4),
  ])
}

async function withInstance(fn: () => Promise<void>, models: Record<string, object> = {}) {
  const server = state.server!
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          enabled_providers: ["anthropic"],
          model: `anthropic/${MODEL}`,
          instructions: [],
          provider: { anthropic: { options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1` }, models } },
        }),
      )
      await Bun.write(path.join(dir, "AGENTS.md"), "PROJECT-RULES-MUST-NOT-LEAK")
    },
  })
  await Instance.provide({ directory: tmp.path, fn })
}

function markers(body: Body) {
  return [...JSON.stringify(body).matchAll(/"cache_control":(\{[^}]*\})/g)].map((match) => JSON.parse(match[1]))
}

function thinkingReply(thought: string, text: string, reason = "end_turn") {
  return sse([
    start,
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: thought } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 1 },
    ...stop(reason, 4),
  ])
}

const priced = {
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
  },
}

const overloaded = () =>
  new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), {
    status: 529,
    headers: { "Content-Type": "application/json" },
  })

async function collect(events: AsyncIterable<Oneshot.Event>) {
  const out: Oneshot.Event[] = []
  for await (const event of events) out.push(event)
  return out
}

function systemText(body: Body) {
  return JSON.stringify(body.system ?? "")
}

describe("Oneshot.run", () => {
  test("a call with no system prompt sends no system blocks at all", async () => {
    await withInstance(async () => {
      const request = respond(() => textReply("ok"))
      await Oneshot.run({ model: "default", variant: "default", prompt: "Hi" })
      expect((await request).body.system).toBeUndefined()
    })
  }, 30_000)

  test("sends only the caller's system prompt and prompt, no tools or cache markers, and returns the text with usage", async () => {
    await withInstance(async () => {
      const request = respond(() => textReply("Hello back"))
      const answer = await Oneshot.run({ model: "default", variant: "default", system: "CALLER-SYSTEM", prompt: "Hi" })
      const capture = await request

      expect(systemText(capture.body)).toContain("CALLER-SYSTEM")
      expect(capture.body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Hi" }] }])
      expect(JSON.stringify(capture.body)).not.toContain("PROJECT-RULES-MUST-NOT-LEAK")
      expect(JSON.stringify(capture.body)).not.toContain("cache_control")
      expect(capture.body.tools).toBeUndefined()

      expect(answer).toMatchObject({
        result: "Hello back",
        finish: "stop",
        usage: { input: 10, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        model: `anthropic/${MODEL}`,
        is_error: false,
        errors: [],
      })
    })
  }, 30_000)

  test("cache on marks only the system prompt, once, with a 1h ttl; the prompt stays unmarked", async () => {
    await withInstance(async () => {
      const request = respond(() => textReply("ok"))
      await Oneshot.run({ model: "default", variant: "default", system: "S", prompt: "Hi", cache: true })
      const body = (await request).body
      expect(markers(body)).toEqual([{ type: "ephemeral", ttl: "1h" }])
      expect(body.system?.at(-1)).toMatchObject({ text: "S", cache_control: { type: "ephemeral", ttl: "1h" } })
      expect(JSON.stringify(body.messages)).not.toContain("cache_control")
    })
  }, 30_000)

  test("surfaces a provider failure as an error instead of an empty answer", async () => {
    await withInstance(async () => {
      respond(overloaded)
      const answer = await Oneshot.run({ model: "default", variant: "default", prompt: "Hi" })
      expect(answer).toEqual({
        result: "",
        usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0,
        is_error: true,
        errors: [`oneshot: anthropic/${MODEL}: Overloaded`],
        model: `anthropic/${MODEL}`,
      })
    })
  }, 30_000)

  test("POST /oneshot returns the result and rejects a body without a prompt", async () => {
    await withInstance(async () => {
      const app = Server.App()
      const directory = encodeURIComponent(Instance.directory)
      const post = (body: unknown) =>
        app.request(`/oneshot?directory=${directory}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })

      respond(() => textReply("via http"))
      const ok = await post({ prompt: "Hi", model: "default", variant: "default" })
      expect(ok.status).toBe(200)
      expect(await ok.json()).toMatchObject({ result: "via http", is_error: false })

      const bad = await post({ system: "no prompt", model: "default", variant: "default" })
      expect(bad.status).toBe(400)

      const unchosen = await post({ prompt: "Hi" })
      expect(unchosen.status).toBe(400)
    })
  }, 30_000)

  test("rejects a variant the model does not offer", async () => {
    await withInstance(async () => {
      const model = await Provider.defaultModel()
      const answer = await Oneshot.run({ model: "default", variant: "nope", prompt: "Hi" })
      expect(answer).toMatchObject({
        is_error: true,
        errors: [`oneshot: model ${model.providerID}/${model.modelID} offers no variant "nope"`],
      })
    })
  }, 30_000)

  test("default resolves the model's configured variant onto the wire", async () => {
    await withInstance(
      async () => {
        const request = respond(() => textReply("ok"))
        const answer = await Oneshot.run({ model: "default", variant: "default", prompt: "Hi" })
        expect(answer.errors).toEqual([])
        expect((await request).body.thinking).toEqual({ type: "enabled", budget_tokens: 4095 })
      },
      {
        [MODEL]: {
          name: "Claude",
          family: "claude",
          release_date: "2024-10-22",
          attachment: false,
          reasoning: true,
          temperature: true,
          tool_call: true,
          cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
          limit: { context: 200000, output: 8192 },
          modalities: { input: ["text"], output: ["text"] },
          variant: "high",
        },
      },
    )
  }, 30_000)
})

describe("Oneshot.stream", () => {
  const input = (abort = new AbortController().signal) => ({
    system: "SYS",
    prompt: "Hi",
    sessionID: "ses_test",
    model: "default",
    variant: "default",
    abort,
    cache: true,
  })

  test("yields only answer text, drops reasoning by type, and ends with done", async () => {
    await withInstance(async () => {
      const request = respond(() => thinkingReply("SECRET-THOUGHT", "Spoken line."))
      const events = await collect(Oneshot.stream(input()))
      expect(markers((await request).body)).toEqual([{ type: "ephemeral", ttl: "1h" }])
      expect(events).toEqual([
        { type: "text", text: "Spoken line." },
        {
          type: "done",
          finish: "stop",
          model: `anthropic/${MODEL}`,
          usage: { input: 10, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          cost: (10 * 1 + 4 * 2) / 1_000_000,
          thoughts: 1,
        },
      ])
    }, priced)
  }, 30_000)

  test("a truncated answer is an error, not a done", async () => {
    await withInstance(async () => {
      respond(() => thinkingReply("t", "Cut off", "max_tokens"))
      const events = await collect(Oneshot.stream(input()))
      expect(events).toEqual([
        { type: "text", text: "Cut off" },
        {
          type: "error",
          message: `oneshot: anthropic/${MODEL}: finished with "length" instead of a normal stop`,
        },
      ])
    })
  }, 30_000)

  test("a provider failure ends the stream with one error naming the model", async () => {
    await withInstance(async () => {
      respond(overloaded)
      const events = await collect(Oneshot.stream(input()))
      expect(events).toEqual([{ type: "error", message: `oneshot: anthropic/${MODEL}: Overloaded` }])
    })
  }, 30_000)

  test("a model that cannot be resolved is one error, not a throw", async () => {
    const events = await collect(Oneshot.stream(input()))
    expect(events).toEqual([{ type: "error", message: 'oneshot: model "default": No context found for instance' }])
  }, 30_000)

  test("an unknown variant fails before any request", async () => {
    await withInstance(async () => {
      const events = await collect(Oneshot.stream({ ...input(), variant: "nope" }))
      expect(events).toEqual([{ type: "error", message: `oneshot: model anthropic/${MODEL} offers no variant "nope"` }])
    })
  }, 30_000)
})
