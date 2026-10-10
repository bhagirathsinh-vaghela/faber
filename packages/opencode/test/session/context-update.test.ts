import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "path"
import { $ } from "bun"
import { Bus } from "../../src/bus"
import { FileWatcher } from "../../src/file/watcher"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRecent } from "../../src/session/recent"
import { Instance } from "../../src/project/instance"
import { Vcs } from "../../src/project/vcs"
import { Provider } from "../../src/provider/provider"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const MODEL = "claude-3-5-sonnet-20241022"

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  replies: [] as unknown[][],
  gate: undefined as Promise<void> | undefined,
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
const text = [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
  { type: "message_stop" },
]
// A step that ends in a tool call, so the turn runs a second step.
const call = [
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "toolu_1", name: "no_such_tool", input: {} },
  },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } },
  { type: "message_stop" },
]

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json()
      if (body.tools) state.requests++
      const gate = body.tools ? state.gate : undefined
      if (gate) state.gate = undefined
      if (gate) await gate
      const chunks = body.tools ? (state.replies.shift() ?? text) : text
      const payload = [start, ...chunks].map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n") + "\n\n"
      return new Response(payload, { status: 200, headers: { "Content-Type": "text/event-stream" } })
    },
  })
})

afterAll(() => {
  state.server?.stop()
})

async function until(check: () => Promise<boolean> | boolean, what: string, ms = 10_000) {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(10)
  }
}

describe("session-context update block", () => {
  test("a branch move seen mid-turn is announced on the next turn, not recorded as told", async () => {
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
    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const session = await Session.create({})
        const prompt = () =>
          SessionPrompt.prompt({
            variant: Provider.INHERIT,
            sessionID: session.id,
            model: { providerID: "anthropic", modelID: MODEL },
            agent: "build",
            parts: [{ type: "text", text: "go" }],
          })
        const release = Promise.withResolvers<void>()
        state.gate = release.promise
        state.replies.push(call, text)
        const before = state.requests
        const turn = prompt()
        await until(() => state.requests > before, "the first step's request")
        // The branch moves while step one is in flight, so step two is the
        // first to see it, after the opener was already sent.
        await $`git checkout -q -b feature`.cwd(project.path)
        await Bus.publish(FileWatcher.Event.Updated, { file: path.join(project.path, ".git", "HEAD"), event: "change" })
        await until(async () => (await Vcs.branch()) === "feature", "the branch move")
        release.resolve()
        await turn

        expect((await Session.get(session.id)).contextBranch).toBeUndefined()
        await prompt()
        const blocks = (await Session.messages({ sessionID: session.id }))
          .flatMap((m) => m.parts)
          .filter((p) => p.type === "text" && p.synthetic && p.text.includes("feature"))
        expect(blocks.length).toBe(1)
        expect((await Session.get(session.id)).contextBranch).toBe("feature")
        await SessionRecent.remove(session.id)
      },
    })
  }, 30_000)
})
