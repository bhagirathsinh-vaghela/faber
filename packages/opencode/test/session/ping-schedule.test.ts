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
// ping.before_expiry's default, in ms.
const BEFORE_EXPIRY = 10_000

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  requests: 0,
}

function reply() {
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
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ]
  const payload = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n") + "\n\n"
  return new Response(payload, { status: 200, headers: { "Content-Type": "text/event-stream" } })
}

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json()
      if (body.tools) state.requests++
      return reply()
    },
  })
})

afterAll(() => {
  state.server?.stop()
})

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

describe("ping schedule", () => {
  test("a request dispatched while the daemon sleeps cancels the ping it was sleeping toward", async () => {
    await withProject(async () => {
      const session = await Session.create({})
      await SessionPrompt.prompt({
        variant: Provider.INHERIT,
        sessionID: session.id,
        model: { providerID: "anthropic", modelID: MODEL },
        agent: "build",
        parts: [{ type: "text", text: "go" }],
      })
      await SessionPing.stop(session.id)

      // Arm with the ping 1.5s out, then re-anchor the cache the way a
      // dispatching turn does before that deadline arrives.
      await Session.update(
        session.id,
        (draft) => void (draft.cache = { lastRequestAt: Date.now() - CACHE_TTL + BEFORE_EXPIRY + 1500 }),
      )
      const before = state.requests
      SessionPing.start(session.id)
      await Bun.sleep(500)
      await Session.update(session.id, (draft) => void (draft.cache = { lastRequestAt: Date.now() }))
      await Bun.sleep(2500)
      await SessionPing.stop(session.id)
      expect(state.requests - before).toBe(0)
    })
  }, 30_000)
})
