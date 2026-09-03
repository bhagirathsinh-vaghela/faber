import { test, expect } from "bun:test"
import { MCP } from "../../src/mcp/index"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

// MCP.readOnly classifies a tool for the read-only subtask grant. The MCP spec
// makes annotations.readOnlyHint an optional hint that defaults to false, so the
// classifier trusts it ONLY when a server advertises readOnlyHint === true and
// treats everything else (hint absent, or false) as a WRITE. These drive a real
// stdio MCP server advertising all three shapes and assert each end to end.

// A minimal stdio MCP server: one tool with readOnlyHint true, one with it
// false, one with no annotations at all. Written into the tmpdir and spawned by
// MCP.state() so the cached tool defs carry real annotations off the wire.
const SERVER = `
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"

const server = new McpServer({ name: "annotated", version: "1.0.0" })
const ok = async () => ({ content: [{ type: "text", text: "ok" }] })
server.registerTool("look", { description: "a read", annotations: { readOnlyHint: true } }, ok)
server.registerTool("change", { description: "a write", annotations: { readOnlyHint: false } }, ok)
server.registerTool("plain", { description: "no annotation" }, ok)
await server.connect(new StdioServerTransport())
`

async function withServer<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const server = `${dir}/server.mjs`
      await Bun.write(server, SERVER)
      await Bun.write(
        `${dir}/opencode.json`,
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          mcp: { annotated: { type: "local", command: [process.execPath, server] } },
        }),
      )
    },
  })
  return Instance.provide({ directory: tmp.path, fn })
}

test("readOnly is true only for a tool advertising readOnlyHint true", async () => {
  await withServer(async () => {
    // Force the client set to build (connects + caches the annotated tool defs).
    await MCP.tools()
    expect(await MCP.readOnly("annotated_look")).toBe(true)
    expect(await MCP.readOnly("annotated_change")).toBe(false)
    expect(await MCP.readOnly("annotated_plain")).toBe(false)
  })
}, 20_000)

test("readOnly is false for an unknown tool key (fail safe)", async () => {
  await withServer(async () => {
    await MCP.tools()
    expect(await MCP.readOnly("annotated_missing")).toBe(false)
  })
}, 20_000)
