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

let server: ReturnType<typeof Bun.serve> | null = null

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
  server = Bun.serve({ port: 0, fetch: () => reply() })
})

afterAll(() => {
  server?.stop()
})

describe("command placeholders", () => {
  test("$SESSION is replaced as a whole word only", async () => {
    await using project = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: ["anthropic"],
            model: `anthropic/${MODEL}`,
            provider: { anthropic: { options: { apiKey: "test-key", baseURL: `${server!.url.origin}/v1` } } },
            command: { ids: { template: "this is $SESSION; keep $SESSION_ID and $SESSIONS" } },
          }),
        )
      },
    })
    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const session = await Session.create({})
        await SessionPrompt.command({
          sessionID: session.id,
          command: "ids",
          arguments: "",
          model: Provider.INHERIT,
          variant: Provider.INHERIT,
        })
        const sent = (await Session.messages({ sessionID: session.id }))
          .filter((m) => m.info.role === "user")
          .flatMap((m) => m.parts.flatMap((p) => (p.type === "text" && !p.synthetic ? [p.text] : [])))
        expect(sent).toEqual([`this is ${session.id}; keep $SESSION_ID and $SESSIONS`])
        await SessionRecent.remove(session.id)
      },
    })
  }, 30_000)
})
