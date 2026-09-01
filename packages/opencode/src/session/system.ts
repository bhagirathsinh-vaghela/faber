import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_ANTHROPIC_WITHOUT_TODO from "./prompt/qwen.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"

import PROMPT_CODEX from "./prompt/codex_header.txt"
import PROMPT_QUESTION from "./prompt/question.txt"
import type { Provider } from "@/provider/provider"
import { Instance } from "@/project/instance"
import os from "os"

export const SESSION_CONTEXT_MARKER = "<session_context>"

export namespace SystemPrompt {
  export function instructions() {
    return PROMPT_CODEX.trim()
  }

  export function question() {
    return PROMPT_QUESTION.trim()
  }

  export function provider(model: Provider.Model) {
    if (model.api.id.includes("gpt-5")) return [PROMPT_CODEX]
    if (model.api.id.includes("gpt-") || model.api.id.includes("o1") || model.api.id.includes("o3"))
      return [PROMPT_BEAST]
    if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
    if (model.api.id.includes("claude") || model.providerID === "anthropic") return [PROMPT_ANTHROPIC]
    return [PROMPT_ANTHROPIC_WITHOUT_TODO]
  }

  // Carries only what is stable for a directory. This block sits under a 1h
  // cache marker, and Anthropic hashes cumulatively, so any value that turns
  // over on its own (a date, the checked-out branch) would invalidate the whole
  // prefix behind it on every turnover. Those live in sessionContext instead.
  export function environment() {
    const project = Instance.project
    const shell = os.userInfo().shell?.split("/").pop() ?? "unknown"
    return [
      [
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        `  Working directory: ${Instance.directory}`,
        `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
        `  Platform: ${process.platform}`,
        `  Arch: ${process.arch}`,
        `  Shell: ${shell}`,
        `</env>`,
      ].join("\n"),
    ]
  }

  // Placed on the wire after the 1h-marked system blocks, ahead of the
  // conversation, which puts it past the last 1h marker. It must be written
  // once and never edited in place: it precedes the entire conversation, so
  // rewriting it re-hashes every block behind it. A value that changes later
  // rides sessionContextUpdate at the tail instead.
  export function sessionContext(input: { created: number; branch?: string }) {
    const lines = [SESSION_CONTEXT_MARKER, `  Current date: ${date(input.created)}`]
    if (input.branch) lines.push(`  Current git branch: ${input.branch}`)
    lines.push(`</session_context>`)
    return lines.join("\n")
  }

  // The whole of S3, assembled here so the block always opens with the tag that
  // keeps a 1h marker off it. Composing it at the call site risks a caller that
  // supplies only the later parts, producing an untagged block that then reads
  // as markable — the one failure this tier exists to prevent.
  export function sessionBlock(input: { context?: string; question?: string }) {
    const body = [input.context, input.question].filter(Boolean).join("\n")
    if (!body) return undefined
    return body.startsWith(SESSION_CONTEXT_MARKER) ? body : `${SESSION_CONTEXT_MARKER}\n</session_context>\n${body}`
  }

  // Local calendar day. The session-start value is what sessionContext freezes,
  // so a rollover is detected by comparing this against the frozen one.
  export function date(at: number = Date.now()) {
    const when = new Date(at)
    return `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")}`
  }

  export function sessionContextUpdate(input: { date?: string; branch?: string }) {
    const lines = [`<session_context_update>`]
    if (input.date) lines.push(`  Current date is now: ${input.date}`)
    if (input.branch) lines.push(`  Current git branch is now: ${input.branch}`)
    lines.push(`</session_context_update>`)
    return lines.join("\n")
  }
}
