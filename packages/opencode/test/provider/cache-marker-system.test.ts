import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "path"
import { ProviderTransform } from "../../src/provider/transform"
import { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { LLM } from "../../src/session/llm"
import { SESSION_CONTEXT_MARKER } from "../../src/session/system"
import { Log } from "../../src/util/log"
import type { Agent } from "../../src/agent/agent"
import type { MessageV2 } from "../../src/session/message-v2"
import type { ModelMessage } from "ai"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

function system(text: string): ModelMessage {
  return { role: "system", content: text }
}

function prompt(text: string): ModelMessage {
  return { role: "user", content: [{ type: "text" as const, text }] }
}

function reply(text: string): ModelMessage {
  return { role: "assistant", content: [{ type: "text" as const, text }] }
}

const CONTEXT = `${SESSION_CONTEXT_MARKER}\n  Current date: 2026-09-29\n</session_context>`

// A one-shot call is never re-sent, so only its reusable instructions are worth
// a marker; the session strategy must stay exactly as it is.
describe("system-scope cache markers", () => {
  test("mark only the last system block, never a message", () => {
    const msgs = [system("preamble"), system("instructions"), prompt("the message")]
    expect(ProviderTransform.cacheMarkerIndices(msgs, undefined, "system")).toEqual([1])
  })

  test("skip a session-context block", () => {
    const msgs = [system("preamble"), system("instructions"), system(CONTEXT), prompt("the message")]
    expect(ProviderTransform.cacheMarkerIndices(msgs, undefined, "system")).toEqual([1])
  })

  test("mark nothing when there is no system block", () => {
    expect(ProviderTransform.cacheMarkerIndices([prompt("the message")], undefined, "system")).toEqual([])
  })

  test("leave the session strategy unchanged", () => {
    const msgs = [system("preamble"), system("S1"), system("S2"), prompt("turn one"), reply("done"), prompt("turn two")]
    expect(ProviderTransform.cacheMarkerIndices(msgs)).toEqual([1, 2, 4, 5])
  })
})

describe("system-scope cache markers on the wire", () => {
  const MODEL = "claude-3-5-sonnet-20241022"
  const upstream = {
    server: null as ReturnType<typeof Bun.serve> | null,
    bodies: [] as { system: unknown[]; messages: unknown[] }[],
  }
  const frames = [
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
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]

  beforeAll(() => {
    upstream.server = Bun.serve({
      port: 0,
      async fetch(req) {
        upstream.bodies.push((await req.json()) as { system: unknown[]; messages: unknown[] })
        return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
          headers: { "Content-Type": "text/event-stream" },
        })
      },
    })
  })

  afterAll(() => {
    upstream.server?.stop(true)
  })

  test('cache: "system" through LLM.stream puts one 1h marker on the last non-session system block and none on messages', async () => {
    await using project = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: ["anthropic"],
            provider: {
              anthropic: { options: { apiKey: "test-key", baseURL: `${upstream.server!.url.origin}/v1` } },
            },
          }),
        )
      },
    })
    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const model = await Provider.getModel("anthropic", MODEL)
        const agent = {
          name: "oneshot",
          mode: "primary",
          prompt: "PERSONA",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "deny" }],
        } satisfies Agent.Info
        const user = {
          id: "msg_user",
          sessionID: "ses_cache",
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: "anthropic", modelID: MODEL },
        } satisfies MessageV2.User
        const { stream } = await LLM.stream({
          user,
          sessionID: "ses_cache",
          model,
          agent,
          system: { env: ["ENV"], globalInstructions: [], projectInstructions: ["PROJECT"], sessionContext: CONTEXT },
          abort: new AbortController().signal,
          messages: [prompt("first"), reply("answer"), prompt("second")],
          tools: {},
          cache: "system",
        })
        for await (const _ of stream.fullStream) {
        }
      },
    })

    const body = upstream.bodies.at(-1)!
    expect(body.system).toEqual([
      { type: "text", text: "PERSONA" },
      { type: "text", text: "ENV\nPROJECT", cache_control: { type: "ephemeral", ttl: "1h" } },
      { type: "text", text: CONTEXT },
    ])
    expect(JSON.stringify(body.messages)).not.toContain("cache_control")
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
      { role: "user", content: [{ type: "text", text: "second" }] },
    ])
  }, 30_000)
})
