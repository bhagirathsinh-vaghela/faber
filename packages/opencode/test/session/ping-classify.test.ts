import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "path"
import { Session } from "../../src/session"
import { CACHE_TTL, SessionPing } from "../../src/session/ping"
import { SessionPrompt } from "../../src/session/prompt"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const MODEL = "claude-3-5-sonnet-20241022"

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  mode: "ok" as "ok" | "fail" | "hold",
  requests: 0,
}

const start = {
  type: "message_start",
  message: {
    id: "msg-1",
    model: MODEL,
    usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  },
}
const rest = [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
  { type: "message_stop" },
]
const frame = (chunk: unknown) => `data: ${JSON.stringify(chunk)}\n\n`
const sse = { "Content-Type": "text/event-stream" }

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json()
      if (body.tools) state.requests++
      if (body.tools && state.mode === "fail")
        return Response.json(
          { type: "error", error: { type: "invalid_request_error", message: "test server" } },
          { status: 400 },
        )
      // The response opens and then stalls, so the ping is mid-stream when
      // its daemon is stopped.
      if (body.tools && state.mode === "hold")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(frame(start) + frame(rest[0])))
            },
          }),
          { headers: sse },
        )
      return new Response([start, ...rest].map(frame).join(""), { headers: sse })
    },
  })
})

afterAll(() => {
  state.server?.stop()
})

async function until(check: () => boolean, what: string, ms = 10_000) {
  const deadline = Date.now() + ms
  while (!check()) {
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
          ping: { enabled: true },
          provider: { anthropic: { options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` } } },
        }),
      )
    },
  })
  await Instance.provide({ directory: project.path, fn })
}

async function turn() {
  const session = await Session.create({})
  state.mode = "ok"
  await SessionPrompt.prompt({
    variant: Provider.INHERIT,
    sessionID: session.id,
    model: { providerID: "anthropic", modelID: MODEL },
    agent: "build",
    parts: [{ type: "text", text: "go" }],
  })
  await SessionPing.stop(session.id)
  return session
}

describe("ping outcome", () => {
  test("a ping the server rejects is a miss, not a warmed cache", async () => {
    await withProject(async () => {
      const session = await turn()
      state.mode = "fail"
      await SessionPing.probe(session.id, "")
      await SessionPing.stop(session.id)
      expect((await Session.get(session.id)).ping?.count ?? 0).toBe(0)
    })
  }, 30_000)

  test("a ping its daemon stops mid-stream counts as no ping", async () => {
    await withProject(async () => {
      const session = await turn()
      // Anchor the cache so the ping is already due when the daemon arms.
      await Session.update(session.id, (draft) => void (draft.cache = { lastRequestAt: Date.now() - CACHE_TTL + 5000 }))
      state.mode = "hold"
      const before = state.requests
      SessionPing.start(session.id)
      await until(() => state.requests > before, "the ping's request")
      await Bun.sleep(200)
      await SessionPing.stop(session.id)
      await Bun.sleep(300)
      expect((await Session.get(session.id)).ping?.count ?? 0).toBe(0)
    })
  }, 30_000)
})
