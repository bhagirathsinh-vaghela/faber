import { test, expect } from "bun:test"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { MCP } from "../../src/mcp/index"

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")

// The SDK rejects a slow or cancelled call with McpError(-32001, "Request timed
// out"), which is indistinguishable in the UI from a dead server, so these
// assert the two ways convertMcpTool keeps a live call from reaching it: a
// server reporting progress must extend the deadline, and an aborted turn must
// cancel rather than sit until the timer expires.
async function connect(register: (server: McpServer) => void) {
  const server = new McpServer({ name: "test", version: "1.0.0" })
  register(server)
  const client = new Client({ name: "opencode-test", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

const noInput = { type: "object" as const, properties: {} }

test("progress notifications extend the deadline past the configured timeout", async () => {
  const client = await connect((server) =>
    server.registerTool("slow", { description: "reports progress" }, async (extra) => {
      for (let sent = 0; sent < 4; sent++) {
        await Bun.sleep(60)
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken: extra._meta?.progressToken!, progress: sent + 1, total: 4 },
        })
      }
      return { content: [{ type: "text" as const, text: "done" }] }
    }),
  )

  const tool = await MCP.convertMcpTool({ name: "slow", inputSchema: noInput }, client, 100)
  const result = await tool.execute!({}, { toolCallId: "call-1", messages: [] })

  expect(result).toEqual({ content: [{ type: "text", text: "done" }] })
})

test("a call still times out when the server reports no progress", async () => {
  const client = await connect((server) =>
    server.registerTool("silent", { description: "never reports progress" }, async () => {
      await Bun.sleep(500)
      return { content: [{ type: "text" as const, text: "done" }] }
    }),
  )

  const tool = await MCP.convertMcpTool({ name: "silent", inputSchema: noInput }, client, 100)
  const err = await tool.execute!({}, { toolCallId: "call-2", messages: [] }).catch((e: Error) => e)

  expect((err as Error).message).toBe("MCP error -32001: Request timed out")
})

test("a server reporting progress forever still hits the ceiling", async () => {
  const client = await connect((server) =>
    server.registerTool("chatty", { description: "never stops reporting progress" }, async (extra) => {
      for (;;) {
        await Bun.sleep(20)
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken: extra._meta?.progressToken!, progress: 1 },
        })
      }
    }),
  )

  const tool = await MCP.convertMcpTool({ name: "chatty", inputSchema: noInput }, client, 100, 300)
  const err = await tool.execute!({}, { toolCallId: "call-4", messages: [] }).catch((e: Error) => e)

  expect((err as Error).message).toBe("MCP error -32001: Maximum total timeout exceeded")
})

test("an aborted turn cancels the call instead of waiting for the timeout", async () => {
  const client = await connect((server) =>
    server.registerTool("hang", { description: "outlives the turn" }, async () => {
      await Bun.sleep(10_000)
      return { content: [{ type: "text" as const, text: "done" }] }
    }),
  )

  const tool = await MCP.convertMcpTool({ name: "hang", inputSchema: noInput }, client, 10_000)
  const abort = new AbortController()
  const start = Date.now()
  const call = tool.execute!({}, { toolCallId: "call-3", messages: [], abortSignal: abort.signal })
  await Bun.sleep(50)
  abort.abort(new Error("turn aborted"))
  const err = await (call as Promise<unknown>).catch((e: Error) => e)

  expect(Date.now() - start).toBeLessThan(1_000)
  expect(err).toBeInstanceOf(Error)
})
