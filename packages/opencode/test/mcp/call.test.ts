import { test, expect } from "bun:test"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { MCP } from "../../src/mcp/index"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

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

test("a dead transport reconnects and the call succeeds", async () => {
  const dead = await connect((server) =>
    server.registerTool("ping", { description: "answers" }, async () => ({
      content: [{ type: "text" as const, text: "first" }],
    })),
  )
  await dead.close()

  let reconnects = 0
  const tool = await MCP.convertMcpTool(
    { name: "ping", inputSchema: noInput },
    dead,
    1_000,
    5_000,
    "probe",
    async () => {
      reconnects++
      return connect((server) =>
        server.registerTool("ping", { description: "answers" }, async () => ({
          content: [{ type: "text" as const, text: "second" }],
        })),
      )
    },
  )

  const answer = await tool.execute!({}, { toolCallId: "call-5", messages: [] })

  // The retry is answered by a process holding none of the state the caller
  // built, which the answer alone cannot distinguish from their own session.
  expect(answer.content[0].text).toContain("was restarted")
  expect(answer.content[0].text).toContain("Redo that setup")
  expect(answer.content[1]).toEqual({ type: "text", text: "second" })
  expect(reconnects).toBe(1)
})

test("a reconnect that cannot revive the server surfaces the original error", async () => {
  const dead = await connect((server) =>
    server.registerTool("ping", { description: "answers" }, async () => ({
      content: [{ type: "text" as const, text: "first" }],
    })),
  )
  await dead.close()

  const tool = await MCP.convertMcpTool(
    { name: "ping", inputSchema: noInput },
    dead,
    1_000,
    5_000,
    "probe",
    async () => undefined,
  )

  const err = await tool.execute!({}, { toolCallId: "call-6", messages: [] }).catch((e: Error) => e)

  expect(err).toBeInstanceOf(Error)
  expect((err as Error).message).toMatch(/not connected|connection closed/i)
})

test("a timeout on a live connection returns the timeout and sends the call once", async () => {
  let runs = 0
  const wedged = await connect((server) =>
    server.registerTool("stuck", { description: "accepts the call, never answers" }, async () => {
      runs++
      await Bun.sleep(60_000)
      return { content: [{ type: "text" as const, text: "never" }] }
    }),
  )

  let reconnects = 0
  const tool = await MCP.convertMcpTool(
    { name: "stuck", inputSchema: noInput },
    wedged,
    150,
    5_000,
    "probe",
    async () => {
      reconnects++
      return connect((server) =>
        server.registerTool("stuck", { description: "answers" }, async () => ({
          content: [{ type: "text" as const, text: "revived" }],
        })),
      )
    },
  )

  const err = await tool.execute!({}, { toolCallId: "call-7", messages: [] }).catch((e: Error) => e)

  expect((err as Error).message).toBe("MCP error -32001: Request timed out")
  expect(runs).toBe(1)
  expect(reconnects).toBe(0)
})

test("a wedged server that cannot be replaced surfaces the timeout", async () => {
  const wedged = await connect((server) =>
    server.registerTool("stuck", { description: "accepts the call, never answers" }, async () => {
      await Bun.sleep(60_000)
      return { content: [{ type: "text" as const, text: "never" }] }
    }),
  )

  const tool = await MCP.convertMcpTool(
    { name: "stuck", inputSchema: noInput },
    wedged,
    150,
    5_000,
    "probe",
    async () => undefined,
  )

  const err = await tool.execute!({}, { toolCallId: "call-8", messages: [] }).catch((e: Error) => e)

  expect((err as Error).message).toBe("MCP error -32001: Request timed out")
})

test("per-project polls and session pins start no servers", async () => {
  await using workspace = await tmpdir({})
  await Instance.provide({
    directory: workspace.path,
    fn: async () => {
      const before = MCP.builds()
      expect(await MCP.prompts()).toEqual({})
      await MCP.status()
      await MCP.reset()
      // Each build spawns one subprocess per configured server.
      expect(MCP.builds() - before).toBe(0)
    },
  })
})

test("a replaced server is picked up by the next call", async () => {
  const first = await connect((server) =>
    server.registerTool("where", { description: "names its process" }, async () => ({
      content: [{ type: "text" as const, text: "first" }],
    })),
  )
  const second = await connect((server) =>
    server.registerTool("where", { description: "names its process" }, async () => ({
      content: [{ type: "text" as const, text: "second" }],
    })),
  )

  await using workspace = await tmpdir({})
  await Instance.provide({
    directory: workspace.path,
    fn: async () => {
      const tool = await MCP.convertMcpTool({ name: "where", inputSchema: noInput }, first, 1_000, 5_000, "probe")

      // Stand in for a replacement that already happened: the tool still holds
      // the client it was built with, while state holds the live one.
      const shared = await MCP.clients()
      shared["probe"] = second

      const answered = await tool.execute!({}, { toolCallId: "call-10", messages: [] })
      expect(answered).toEqual({ content: [{ type: "text", text: "second" }] })
    },
  })
})

test("an aborted call is not retried", async () => {
  const wedged = await connect((server) =>
    server.registerTool("stuck", { description: "accepts the call, never answers" }, async () => {
      await Bun.sleep(60_000)
      return { content: [{ type: "text" as const, text: "never" }] }
    }),
  )

  let reconnects = 0
  const tool = await MCP.convertMcpTool(
    { name: "stuck", inputSchema: noInput },
    wedged,
    10_000,
    30_000,
    "probe",
    async () => {
      reconnects++
      return undefined
    },
  )

  const abort = new AbortController()
  const call = tool.execute!({}, { toolCallId: "call-9", messages: [], abortSignal: abort.signal })
  await Bun.sleep(50)
  abort.abort(new Error("turn aborted"))
  await (call as Promise<unknown>).catch(() => {})

  expect(reconnects).toBe(0)
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
