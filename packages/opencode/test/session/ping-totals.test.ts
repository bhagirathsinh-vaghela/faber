import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "path"
import { Session } from "../../src/session"
import { SessionPing } from "../../src/session/ping"
import { SessionPrompt } from "../../src/session/prompt"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const MODEL = "claude-3-5-sonnet-20241022"

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  write: 0,
}

function reply() {
  const chunks = [
    {
      type: "message_start",
      message: {
        id: "msg-1",
        model: MODEL,
        usage: { input_tokens: 10, cache_creation_input_tokens: state.write, cache_read_input_tokens: 0 },
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
  state.server = Bun.serve({ port: 0, fetch: () => reply() })
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
          provider: { anthropic: { options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` } } },
        }),
      )
    },
  })
  await Instance.provide({ directory: project.path, fn })
}

describe("session totals", () => {
  test("a record written before total.cacheWrite existed still parses", () => {
    const now = Date.now()
    const record = Session.Info.parse({
      id: "ses_legacy",
      slug: "legacy",
      projectID: "global",
      directory: "/tmp",
      title: "legacy",
      version: "0.0.0",
      time: { created: now, updated: now },
      total: { input: 120, output: 40 },
    })
    expect(record.total).toEqual({ input: 120, output: 40, cacheWrite: 0 })
  })

  test("a keepalive ping adds its cache write to the session total", async () => {
    await withProject(async () => {
      const session = await Session.create({})
      state.write = 0
      await SessionPrompt.prompt({
        variant: Provider.INHERIT,
        sessionID: session.id,
        model: { providerID: "anthropic", modelID: MODEL },
        agent: "build",
        parts: [{ type: "text", text: "go" }],
      })
      expect((await Session.get(session.id)).total.cacheWrite).toBe(0)

      state.write = 50
      await SessionPing.probe(session.id, "")
      expect((await Session.get(session.id)).total.cacheWrite).toBe(50)
      await SessionPing.stop(session.id)
    })
  }, 30_000)
})
