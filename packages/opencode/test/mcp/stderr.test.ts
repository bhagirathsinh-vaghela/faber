import { test, expect } from "bun:test"
import { BunStdioTransport } from "../../src/mcp/stdio"

// A server's diagnostics must never decide whether its replies arrive. Piping
// stderr couples the two: the pipe holds ~64KB, then the child blocks inside
// write(2) still holding requests it accepted, and draining that pipe from this
// process starves the stdout reader instead. Either failure loses the reply with
// nothing on any stream to say so, which reads exactly like a hung server.
//
// The invariant is therefore structural — no stderr pipe exists to fill. It is
// asserted directly rather than by flooding a child, because the flood's outcome
// under `bun test` depends on how the runner drains ITS stderr, so a functional
// test here would measure the harness.

test("no stderr pipe is created for the child", async () => {
  const transport = new BunStdioTransport({
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 5000)"],
  })
  await transport.start()

  const spawned = (transport as unknown as { proc: { stderr: unknown } }).proc

  expect(spawned.stderr).toBeNull()
  await transport.close()
})

test("a reply still arrives after the child writes to stderr", async () => {
  const transport = new BunStdioTransport({
    command: process.execPath,
    args: [
      "-e",
      [
        "const fs = require('fs')",
        "fs.writeSync(2, 'diagnostics from the server\\n')",
        "fs.writeSync(1, JSON.stringify({ jsonrpc: '2.0', id: 1, result: { done: true } }) + '\\n')",
      ].join("\n"),
    ],
  })
  const replied = new Promise<unknown>((resolve) => {
    transport.onmessage = resolve
  })
  await transport.start()

  const message = await Promise.race([replied, new Promise((resolve) => setTimeout(() => resolve("no reply"), 10_000))])
  await transport.close()

  expect(message).toEqual({ jsonrpc: "2.0", id: 1, result: { done: true } })
}, 20_000)
