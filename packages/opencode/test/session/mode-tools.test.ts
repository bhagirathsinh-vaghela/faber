import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "path"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRecent } from "../../src/session/recent"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const MODEL = "claude-3-5-sonnet-20241022"

type Body = { tools?: { name: string }[]; messages: { content: unknown }[] }

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  requests: [] as Body[],
  replies: [] as unknown[][],
}

const start = {
  type: "message_start",
  message: {
    id: "msg-1",
    model: MODEL,
    usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  },
}
const text = [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
  { type: "message_stop" },
]
const call = (name: string) => [
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name, input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } },
  { type: "message_stop" },
]

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Body
      if (body.tools) state.requests.push(body)
      const chunks = body.tools ? (state.replies.shift() ?? text) : text
      const payload = [start, ...chunks].map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n") + "\n\n"
      return new Response(payload, { status: 200, headers: { "Content-Type": "text/event-stream" } })
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
          provider: { anthropic: { options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` } } },
        }),
      )
    },
  })
  await Instance.provide({ directory: project.path, fn })
}

function prompt(sessionID: string, agent: string) {
  return SessionPrompt.prompt({
    variant: Provider.INHERIT,
    sessionID,
    model: { providerID: "anthropic", modelID: MODEL },
    agent,
    parts: [{ type: "text", text: "go" }],
  })
}

describe("plan mode switch tools", () => {
  test("build and plan send the same tools[] under the default permissions", async () => {
    await withProject(async () => {
      const session = await Session.create({})
      state.requests.length = 0
      await prompt(session.id, "build")
      await prompt(session.id, "plan")
      const names = state.requests.map((body) => body.tools!.map((tool) => tool.name))
      expect(names.length).toBe(2)
      expect(names[1]).toEqual(names[0])
      expect(names[0]).toContain("plan_enter")
      expect(names[0]).toContain("plan_exit")
      await SessionRecent.remove(session.id)
    })
  }, 30_000)

  test("the agent the permissions deny a switch tool is refused when it calls it", async () => {
    await withProject(async () => {
      const session = await Session.create({})
      state.requests.length = 0
      state.replies.push(call("plan_exit"))
      await prompt(session.id, "build")
      expect(JSON.stringify(state.requests[1].messages)).toContain(
        'Tool \\"plan_exit\\" is not available to the build agent.',
      )
      await SessionRecent.remove(session.id)
    })
  }, 30_000)
})
