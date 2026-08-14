import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js"
import { spawn, type ChildProcess } from "node:child_process"

export type StdioParams = {
  command: string
  args?: string[]
  env?: Record<string, string | undefined>
  cwd?: string
}

/**
 * MCP stdio transport over node:child_process streams.
 *
 * Bun.spawn's stdout ReadableStream was observed going silent mid-session in
 * the live server: the child kept answering (a tee on its stdout captured the
 * reply frames), but reader.read() stopped resolving after a few frames, so
 * every later call timed out as unanswered (oven-sh/bun#1320 is the same
 * shape). node's event-driven streams deliver those same frames reliably, and
 * they are what the reference MCP SDK client rides on.
 *
 * stderr is INHERITED, never piped: a piped stream nobody drains holds ~64KB
 * and then blocks the child inside write(2), stranding requests it already
 * accepted with nothing on any stream to say so.
 */
export class BunStdioTransport implements Transport {
  private proc: ChildProcess | undefined
  private params: StdioParams

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  constructor(params: StdioParams) {
    this.params = params
  }

  async start() {
    if (this.proc) throw new Error("BunStdioTransport already started")

    const params = this.params
    const proc = spawn(params.command, params.args ?? [], {
      stdio: ["pipe", "pipe", "inherit"],
      cwd: params.cwd,
      env: params.env as Record<string, string>,
    })
    this.proc = proc

    const decoder = new TextDecoder()
    let buf = ""
    proc.stdout!.on("data", (chunk: Buffer) => {
      buf += decoder.decode(chunk, { stream: true })
      let idx: number
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (!line) continue
        try {
          this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(line)))
        } catch (e) {
          this.onerror?.(e instanceof Error ? e : new Error(String(e)))
        }
      }
    })

    proc.on("error", (error) => {
      this.onerror?.(error)
    })

    proc.on("exit", () => {
      this.proc = undefined
      this.onclose?.()
    })
  }

  async send(message: JSONRPCMessage) {
    const stdin = this.proc?.stdin
    if (!stdin || !stdin.writable) throw new Error("Not connected")
    // The write callback fires once the frame is handed to the kernel, so
    // resolving there guarantees the whole frame is out before the caller
    // starts its response timer. A settled promise ignores the extra resolve
    // from 'drain' after a full buffer.
    await new Promise<void>((resolve, reject) => {
      const flushed = stdin.write(JSON.stringify(message) + "\n", (error) => {
        if (error) reject(error)
        else resolve()
      })
      if (flushed === false) stdin.once("drain", resolve)
    })
  }

  async close() {
    const proc = this.proc
    if (!proc) return
    this.proc = undefined

    proc.stdin?.end()

    const exited = () => proc.exitCode !== null || proc.signalCode !== null
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        if (exited()) return resolve()
        const timer = setTimeout(() => resolve(), ms)
        proc.once("exit", () => {
          clearTimeout(timer)
          resolve()
        })
      })

    await wait(2000)
    if (!exited()) {
      proc.kill()
      await wait(2000)
      if (!exited()) proc.kill("SIGKILL")
    }

    this.onclose?.()
  }
}
