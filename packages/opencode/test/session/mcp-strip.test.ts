import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "path"
import z from "zod"
import { tool, type ModelMessage } from "ai"
import { McpCatalog } from "../../src/mcp/catalog"
import { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { LLM } from "../../src/session/llm"
import { Log } from "../../src/util/log"
import type { Agent } from "../../src/agent/agent"
import type { MessageV2 } from "../../src/session/message-v2"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const MODEL = "claude-3-5-haiku-20241022"

const catalog = McpCatalog.build([
  { key: "docs_lookup", client: "docs", tier: "name", name: "lookup", description: "Find a doc", schema: {} },
  { key: "docs_fetch", client: "docs", tier: "description", name: "fetch", description: "Fetch a doc", schema: {} },
])!

const prompt = (text: string): ModelMessage => ({ role: "user", content: [{ type: "text", text }] })

describe("McpCatalog.listed", () => {
  test("reads back every name a built catalog lists", () => {
    expect([...McpCatalog.listed([prompt("hi"), prompt(catalog)])].sort()).toEqual(["docs_fetch", "docs_lookup"])
  })

  test("a conversation with no catalog lists nothing", () => {
    expect(McpCatalog.listed([prompt("hi"), { role: "user", content: "plain" }]).size).toBe(0)
  })

  test("a malformed or pasted block is skipped, never thrown", () => {
    const opening = catalog.slice(0, catalog.indexOf("\n", "<mcp_tool_catalog>\n".length) + 1)
    const pasted = ["<mcp_tool_catalog>", "my own notes", '[{"tools":[{"name":"docs_lookup"}]}]', "</mcp_tool_catalog>"]
    const broken = [
      opening + "[ not json ]\n</mcp_tool_catalog>",
      opening + "{}\n</mcp_tool_catalog>",
      opening + '[{"tools":null}]\n</mcp_tool_catalog>',
    ]
    expect(McpCatalog.listed([prompt(pasted.join("\n")), ...broken.map(prompt)]).size).toBe(0)
  })
})

describe("MCP tools on the Anthropic wire", () => {
  const upstream = {
    server: null as ReturnType<typeof Bun.serve> | null,
    bodies: [] as { tools?: { name: string }[] }[],
  }
  const frames = [
    { type: "message_start", message: { id: "m", model: MODEL, usage: { input_tokens: 1, output_tokens: 0 } } },
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
        upstream.bodies.push((await req.json()) as { tools?: { name: string }[] })
        return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
          headers: { "Content-Type": "text/event-stream" },
        })
      },
    })
  })

  afterAll(() => upstream.server?.stop(true))

  async function sent(messages: ModelMessage[], mcp: object = {}) {
    await using project = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: ["anthropic"],
            provider: { anthropic: { options: { apiKey: "test-key", baseURL: `${upstream.server!.url.origin}/v1` } } },
            mcp,
          }),
        )
      },
    })
    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const model = await Provider.getModel("anthropic", MODEL)
        const agent = { name: "build", mode: "primary", options: {}, permission: [] } satisfies Agent.Info
        const user = {
          id: "msg_user",
          sessionID: "ses_mcp",
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: "anthropic", modelID: MODEL },
        } satisfies MessageV2.User
        const make = (description: string) => tool({ description, inputSchema: z.object({}), execute: async () => "" })
        const { stream } = await LLM.stream({
          user,
          sessionID: "ses_mcp",
          model,
          agent,
          system: { env: [], globalInstructions: [], projectInstructions: [] },
          abort: new AbortController().signal,
          messages,
          tools: { read: make("read a file"), docs_lookup: make("Find a doc"), docs_fetch: make("Fetch a doc") },
        })
        for await (const _ of stream.fullStream) {
        }
      },
    })
    return (upstream.bodies.at(-1)?.tools ?? []).map((t) => t.name).sort()
  }

  test("an MCP tool the catalog lists is left out of tools[]", async () => {
    expect(await sent([prompt(catalog), prompt("go")])).toEqual(["read"])
  })

  test("a tool its server disables is left out once a catalog is present", async () => {
    const only = McpCatalog.build([
      { key: "docs_fetch", client: "docs", tier: "name", name: "fetch", description: "", schema: {} },
    ])!
    const mcp = { docs: { type: "local", command: ["true"], enabled: false, disabled: ["lookup"] } }
    expect(await sent([prompt(only), prompt("go")], mcp)).toEqual(["read"])
  })

  test("with no catalog in the conversation every tool is sent", async () => {
    expect(await sent([prompt("go")])).toEqual(["docs_fetch", "docs_lookup", "read"])
  })
})
