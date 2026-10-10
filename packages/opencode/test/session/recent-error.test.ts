import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "path"
import { Session } from "../../src/session"
import { SessionBusy } from "../../src/session/busy"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRecent } from "../../src/session/recent"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const MODEL = "claude-3-5-sonnet-20241022"

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  fail: false,
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

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json()
      if (!body.tools) return reply("a title")
      // A 400 is not retried, so the turn ends on the error at once.
      if (state.fail)
        return Response.json(
          { type: "error", error: { type: "invalid_request_error", message: "test server" } },
          { status: 400 },
        )
      return reply("done")
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
          provider: { anthropic: { options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` } } },
        }),
      )
    },
  })
  await Instance.provide({ directory: project.path, fn })
}

async function turn(sessionID: string, fail: boolean) {
  state.fail = fail
  await SessionPrompt.prompt({
    variant: Provider.INHERIT,
    sessionID,
    model: { providerID: "anthropic", modelID: MODEL },
    agent: "build",
    parts: [{ type: "text", text: "go" }],
  }).catch(() => undefined)
  await until(() => !SessionBusy.busy(sessionID), "the turn to end")
  await Bun.sleep(100)
  return (await SessionRecent.list()).find((entry) => entry.sessionID === sessionID)?.error
}

describe("overview error flag", () => {
  test("a failed turn keeps its error dot until the next turn starts", async () => {
    await withProject(async () => {
      const session = await Session.create({})
      expect(await turn(session.id, true)).toBe(true)
      expect(await turn(session.id, false)).toBe(false)
      await SessionRecent.remove(session.id)
    })
  }, 30_000)
})
