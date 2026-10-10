import fs from "fs/promises"
import path from "path"
import { Global } from "../global"
import { Identifier } from "../id/id"
import { PermissionNext } from "../permission/next"
import type { Agent } from "../agent/agent"
import { Scheduler } from "../scheduler"

export namespace Truncate {
  export const MAX_LINES = 2000
  export const MAX_BYTES = 50 * 1024
  // A persisted diff is display-only metadata (the model reads the tool's
  // `output` string, never `metadata`), so an unbounded patch on a huge edit is
  // pure storage/serialization cost. Cap the persisted copy; the renderer shows
  // a truncation marker for the rest.
  export const MAX_DIFF_BYTES = 50 * 1024
  export const DIR = path.join(Global.Path.data, "tool-output")
  export const GLOB = path.join(DIR, "*")
  const RETENTION_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
  const HOUR_MS = 60 * 60 * 1000

  export type Result = { content: string; truncated: false } | { content: string; truncated: true; outputPath: string }

  export interface Options {
    maxLines?: number
    maxBytes?: number
    direction?: "head" | "tail"
  }

  export function init() {
    Scheduler.register({
      id: "tool.truncation.cleanup",
      interval: HOUR_MS,
      run: cleanup,
      scope: "global",
    })
  }

  export async function cleanup() {
    // Age comes from the file's mtime, not the id. An id minted with the legacy
    // 6-byte time field holds only the low bits of (ms * 0x1000), so
    // Identifier.timestamp decodes it to a time that wraps every ~800 days. The
    // filesystem mtime is the real write time for every file in the directory.
    const cutoff = Date.now() - RETENTION_MS
    const glob = new Bun.Glob("tool_*")
    const entries = await Array.fromAsync(glob.scan({ cwd: DIR, onlyFiles: true })).catch(() => [] as string[])
    for (const entry of entries) {
      const file = path.join(DIR, entry)
      const stat = await fs.stat(file).catch(() => undefined)
      if (!stat || stat.mtimeMs >= cutoff) continue
      await fs.unlink(file).catch(() => {})
    }
  }

  function hasAgentTool(agent?: Agent.Info): boolean {
    if (!agent?.permission) return false
    const rule = PermissionNext.evaluate("agent", "*", agent.permission)
    return rule.action !== "deny"
  }

  export function diff(patch: string): string {
    const bytes = Buffer.from(patch)
    if (bytes.length <= MAX_DIFF_BYTES) return patch
    // Decoding a cut that splits a multi-byte character yields trailing U+FFFD
    const head = bytes.subarray(0, MAX_DIFF_BYTES).toString()
    const cutoff = head.lastIndexOf("\n")
    const kept = cutoff > 0 ? head.slice(0, cutoff) : head.replace(/\uFFFD+$/, "")
    const rest = patch.slice(cutoff > 0 ? cutoff + 1 : kept.length)
    const remaining = rest.split("\n").length - Number(rest.endsWith("\n"))
    return `${kept}\n\n... [${remaining} lines truncated] ...`
  }

  export async function output(text: string, options: Options = {}, agent?: Agent.Info): Promise<Result> {
    const maxLines = options.maxLines ?? MAX_LINES
    const maxBytes = options.maxBytes ?? MAX_BYTES
    const direction = options.direction ?? "head"
    const lines = text.split("\n")
    const totalBytes = Buffer.byteLength(text, "utf-8")

    if (lines.length <= maxLines && totalBytes <= maxBytes) {
      return { content: text, truncated: false }
    }

    const out: string[] = []
    let i = 0
    let bytes = 0
    let hitBytes = false

    if (direction === "head") {
      for (i = 0; i < lines.length && i < maxLines; i++) {
        const size = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0)
        if (bytes + size > maxBytes) {
          hitBytes = true
          break
        }
        out.push(lines[i])
        bytes += size
      }
    } else {
      for (i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
        const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
        if (bytes + size > maxBytes) {
          hitBytes = true
          break
        }
        out.unshift(lines[i])
        bytes += size
      }
    }

    const removed = hitBytes ? totalBytes - bytes : lines.length - out.length
    const unit = hitBytes ? "bytes" : "lines"
    const preview = out.join("\n")

    const id = Identifier.ascending("tool")
    const filepath = path.join(DIR, id)
    await Bun.write(Bun.file(filepath), text)

    const hint = hasAgentTool(agent)
      ? `The tool call succeeded but the output was truncated. Full output saved to: ${filepath}\nUse the Agent tool to have explore agent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context.`
      : `The tool call succeeded but the output was truncated. Full output saved to: ${filepath}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`
    const message =
      direction === "head"
        ? `${preview}\n\n...${removed} ${unit} truncated...\n\n${hint}`
        : `...${removed} ${unit} truncated...\n\n${hint}\n\n${preview}`

    return { content: message, truncated: true, outputPath: filepath }
  }
}
