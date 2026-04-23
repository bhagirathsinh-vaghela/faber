import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_ANTHROPIC_WITHOUT_TODO from "./prompt/qwen.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"

import PROMPT_CODEX from "./prompt/codex_header.txt"
import type { Provider } from "@/provider/provider"
import { Instance } from "@/project/instance"
import os from "os"

export namespace SystemPrompt {
  export function instructions() {
    return PROMPT_CODEX.trim()
  }

  export function provider(model: Provider.Model) {
    if (model.api.id.includes("gpt-5")) return [PROMPT_CODEX]
    if (model.api.id.includes("gpt-") || model.api.id.includes("o1") || model.api.id.includes("o3"))
      return [PROMPT_BEAST]
    if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
    if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
    return [PROMPT_ANTHROPIC_WITHOUT_TODO]
  }

  export function environment(input: { created: number; branch?: string }) {
    const project = Instance.project
    const shell = os.userInfo().shell?.split("/").pop() ?? "unknown"
    const lines = [
      `Here is some useful information about the environment you are running in:`,
      `<env>`,
      `  Working directory: ${Instance.directory}`,
      `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
    ]
    if (input.branch) lines.push(`  Git branch at session start: ${input.branch}`)
    lines.push(
      `  Platform: ${process.platform}`,
      `  Arch: ${process.arch}`,
      `  Shell: ${shell}`,
      `  Session started: ${new Date(input.created).toDateString()}`,
      `</env>`,
    )
    return [lines.join("\n")]
  }
}
