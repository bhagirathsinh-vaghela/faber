import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { Oneshot } from "../../src/session/oneshot"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

type Capture = { headers: Headers; body: Record<string, any> }

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
      next.resolve({ headers: req.headers, body: (await req.json()) as Record<string, any> })
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

async function withInstance(fn: () => Promise<void>) {
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
          provider: { anthropic: { options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1` } } },
        }),
      )
      await Bun.write(path.join(dir, "AGENTS.md"), "PROJECT-RULES-MUST-NOT-LEAK")
    },
  })
  await Instance.provide({ directory: tmp.path, fn })
}

function systemText(body: Record<string, any>) {
  return JSON.stringify(body.system ?? "")
}

describe("Oneshot.run", () => {
  test("sends only the caller's system prompt and prompt, no tools or cache markers, and returns the text with usage", async () => {
    await withInstance(async () => {
      const request = respond(() => textReply("Hello back"))
      const answer = await Oneshot.run({ system: "CALLER-SYSTEM", prompt: "Hi" })
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

  test("places cache markers when the caller opts in", async () => {
    await withInstance(async () => {
      const request = respond(() => textReply("ok"))
      await Oneshot.run({ system: "S", prompt: "Hi", cache: true })
      expect(JSON.stringify((await request).body)).toContain("cache_control")
    })
  }, 30_000)

  test("surfaces a provider failure as an error instead of an empty answer", async () => {
    await withInstance(async () => {
      respond(
        () =>
          new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), {
            status: 529,
            headers: { "Content-Type": "application/json" },
          }),
      )
      const answer = await Oneshot.run({ prompt: "Hi" })
      expect(answer.is_error).toBe(true)
      expect(answer.result).toBe("")
      expect(answer.errors).toHaveLength(1)
      expect(answer.errors[0]).toStartWith(`oneshot: anthropic/${MODEL}: `)
      expect(answer.errors[0]).toContain("Overloaded")
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
      const ok = await post({ prompt: "Hi" })
      expect(ok.status).toBe(200)
      expect(await ok.json()).toMatchObject({ result: "via http", is_error: false })

      const bad = await post({ system: "no prompt" })
      expect(bad.status).toBe(400)
    })
  }, 30_000)
})
