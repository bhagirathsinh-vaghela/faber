import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js"

export type StdioParams = {
  command: string
  args?: string[]
  env?: Record<string, string | undefined>
  cwd?: string
}

/**
 * MCP stdio transport using Bun.spawn instead of node:child_process.
 *
 * The MCP SDK's StdioClientTransport uses node:child_process which under
 * Bun's compiled binary goes through a compatibility polyfill. That polyfill
 * has known bugs where stdin.write() data is silently lost or truncated for
 * larger payloads (oven-sh/bun#13978, #18239, #8695).
 *
 * This transport uses Bun's native spawn API which returns a FileSink for
 * stdin. Each send() calls write() then flush(), guaranteeing the full
 * message reaches the child process regardless of payload size.
 */
export class BunStdioTransport implements Transport {
  private proc: ReturnType<typeof Bun.spawn> | undefined
  private reading = false
  private params: StdioParams

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  constructor(params: StdioParams) {
    this.params = params
  }

  get stderr(): ReadableStream<Uint8Array> | null {
    return (this.proc?.stderr as ReadableStream<Uint8Array>) ?? null
  }

  async start() {
    if (this.proc) throw new Error("BunStdioTransport already started")

    const params = this.params
    this.proc = Bun.spawn([params.command, ...(params.args ?? [])], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: params.cwd,
      env: params.env as Record<string, string>,
    })

    this.readStdout()

    // Fire onclose when the process exits
    this.proc.exited.then(() => {
      this.proc = undefined
      this.onclose?.()
    })
  }

  async send(message: JSONRPCMessage) {
    const stdin = this.proc?.stdin as import("bun").FileSink | undefined
    if (!stdin) throw new Error("Not connected")
    const json = JSON.stringify(message) + "\n"
    stdin.write(json)
    stdin.flush()
  }

  async close() {
    const proc = this.proc
    if (!proc) return
    this.proc = undefined

    // Close stdin to signal EOF to the child
    const stdin = proc.stdin as import("bun").FileSink | undefined
    if (stdin) {
      try {
        stdin.end()
      } catch {}
    }

    // Give the process a moment to exit gracefully, then kill
    const exited = Promise.race([proc.exited, new Promise((r) => setTimeout(r, 2000))])
    await exited

    if (!proc.killed) {
      proc.kill()
      await Promise.race([proc.exited, new Promise((r) => setTimeout(r, 2000))])
      if (!proc.killed) proc.kill("SIGKILL")
    }

    this.onclose?.()
  }

  private async readStdout() {
    if (this.reading) return
    this.reading = true

    const stdout = this.proc?.stdout as ReadableStream<Uint8Array> | undefined
    if (!stdout) return

    const reader = stdout.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx)
          buf = buf.slice(idx + 1)
          if (!line) continue
          try {
            const msg = JSONRPCMessageSchema.parse(JSON.parse(line))
            this.onmessage?.(msg)
          } catch (e) {
            this.onerror?.(e instanceof Error ? e : new Error(String(e)))
          }
        }
      }
    } catch (e) {
      this.onerror?.(e instanceof Error ? e : new Error(String(e)))
    } finally {
      reader.releaseLock()
      this.reading = false
    }
  }
}
