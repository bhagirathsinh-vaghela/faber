import path from "path"
import os from "os"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { Flag } from "@/flag/flag"
import { Log } from "../util/log"
import type { MessageV2 } from "./message-v2"

const log = Log.create({ service: "instruction" })

const FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "CONTEXT.md", // deprecated
]

function formatPath(input: string) {
  const home = Global.Path.home
  const homePrefix = home + path.sep
  const homeRel = input.startsWith(homePrefix) ? `~/${path.relative(home, input)}` : input
  const worktree = Instance.worktree
  const workRel = worktree !== "/" && Filesystem.contains(worktree, input) ? path.relative(worktree, input) : homeRel
  return workRel
}

function globalFiles() {
  const files = [path.join(Global.Path.config, "AGENTS.md")]
  if (!Flag.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT) {
    files.push(path.join(os.homedir(), ".claude", "CLAUDE.md"))
  }
  if (Flag.OPENCODE_CONFIG_DIR) {
    files.push(path.join(Flag.OPENCODE_CONFIG_DIR, "AGENTS.md"))
  }
  return files
}

async function resolveRelative(instruction: string): Promise<string[]> {
  if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
    return Filesystem.globUp(instruction, Instance.directory, Instance.worktree).catch(() => [])
  }
  if (!Flag.OPENCODE_CONFIG_DIR) {
    log.warn(
      `Skipping relative instruction "${instruction}" - no OPENCODE_CONFIG_DIR set while project config is disabled`,
    )
    return []
  }
  return Filesystem.globUp(instruction, Flag.OPENCODE_CONFIG_DIR, Flag.OPENCODE_CONFIG_DIR).catch(() => [])
}

export namespace InstructionPrompt {
  // Cache instructions per instance for prompt cache stability
  // Instructions are loaded once and reused until the instance is disposed (restart, config change, or reload)
  const state = Instance.state(() => ({
    claims: new Map<string, Set<string>>(),
    instructions: undefined as { global: string[]; project: string[] } | undefined,
    paths: undefined as Set<string> | undefined,
  }))

  function isClaimed(messageID: string, filepath: string) {
    const claimed = state().claims.get(messageID)
    if (!claimed) return false
    return claimed.has(filepath)
  }

  function claim(messageID: string, filepath: string) {
    const current = state()
    let claimed = current.claims.get(messageID)
    if (!claimed) {
      claimed = new Set()
      current.claims.set(messageID, claimed)
    }
    claimed.add(filepath)
  }

  export function clear(messageID: string) {
    state().claims.delete(messageID)
  }

  export function reset() {
    state().instructions = undefined
  }

  export async function systemPaths() {
    const config = await Config.get()
    const paths = new Set<string>()

    if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
      for (const file of FILES) {
        const matches = await Filesystem.findUp(file, Instance.directory, Instance.worktree)
        if (matches.length > 0) {
          matches.forEach((p) => {
            paths.add(path.resolve(p))
          })
          break
        }
      }
    }

    for (const file of globalFiles()) {
      if (await Bun.file(file).exists()) {
        paths.add(path.resolve(file))
        break
      }
    }

    if (config.instructions) {
      for (let instruction of config.instructions) {
        if (instruction.startsWith("https://") || instruction.startsWith("http://")) continue
        if (instruction.startsWith("~/")) {
          instruction = path.join(os.homedir(), instruction.slice(2))
        }
        const matches = path.isAbsolute(instruction)
          ? await Array.fromAsync(
              new Bun.Glob(path.basename(instruction)).scan({
                cwd: path.dirname(instruction),
                absolute: true,
                onlyFiles: true,
              }),
            ).catch(() => [])
          : await resolveRelative(instruction)
        matches.forEach((p) => {
          paths.add(path.resolve(p))
        })
      }
    }

    return paths
  }

  export async function system() {
    const cached = state()
    if (cached.instructions) return cached.instructions

    const config = await Config.get()

    // Collect global instruction paths (user-level, cross-repo)
    const globalPaths = new Set<string>()
    for (const file of globalFiles()) {
      if (await Bun.file(file).exists()) {
        globalPaths.add(path.resolve(file))
        break
      }
    }

    // Collect project instruction paths (repo-level)
    const projectPaths = new Set<string>()
    if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
      for (const file of FILES) {
        const matches = await Filesystem.findUp(file, Instance.directory, Instance.worktree)
        if (matches.length > 0) {
          matches.forEach((p) => projectPaths.add(path.resolve(p)))
          break
        }
      }
    }

    // Config instructions go to project (repo-specific)
    if (config.instructions) {
      for (let instruction of config.instructions) {
        if (instruction.startsWith("https://") || instruction.startsWith("http://")) continue
        if (instruction.startsWith("~/")) {
          instruction = path.join(os.homedir(), instruction.slice(2))
        }
        const matches = path.isAbsolute(instruction)
          ? await Array.fromAsync(
              new Bun.Glob(path.basename(instruction)).scan({
                cwd: path.dirname(instruction),
                absolute: true,
                onlyFiles: true,
              }),
            ).catch(() => [])
          : await resolveRelative(instruction)
        matches.forEach((p) => projectPaths.add(path.resolve(p)))
      }
    }

    // A file reachable as both global and project (e.g. cwd inside the global config dir) loads once, as global
    for (const p of globalPaths) projectPaths.delete(p)

    // Load global files
    const globalFiles_ = Array.from(globalPaths)
      .sort()
      .map(async (p) => {
        const content = await Bun.file(p)
          .text()
          .catch(() => "")
        return content ? "Instructions from: " + formatPath(p) + "\n" + content : ""
      })

    // Load project files
    const projectFiles = Array.from(projectPaths)
      .sort()
      .map(async (p) => {
        const content = await Bun.file(p)
          .text()
          .catch(() => "")
        return content ? "Instructions from: " + formatPath(p) + "\n" + content : ""
      })

    // URL instructions go to project
    const urls: string[] = []
    if (config.instructions) {
      for (const instruction of config.instructions) {
        if (instruction.startsWith("https://") || instruction.startsWith("http://")) {
          urls.push(instruction)
        }
      }
    }
    const fetches = urls.map((url) =>
      fetch(url, { signal: AbortSignal.timeout(5000) })
        .then((res) => (res.ok ? res.text() : ""))
        .catch(() => "")
        .then((x) => (x ? "Instructions from: " + url + "\n" + x : "")),
    )

    const [global, project] = await Promise.all([
      Promise.all(globalFiles_).then((r) => r.filter(Boolean)),
      Promise.all([...projectFiles, ...fetches]).then((r) => r.filter(Boolean)),
    ])

    cached.instructions = { global, project }
    cached.paths = new Set([...globalPaths, ...projectPaths])
    return cached.instructions
  }

  export function loaded(messages: MessageV2.WithParts[]) {
    const paths = new Set<string>()
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type === "tool" && part.tool === "read" && part.state.status === "completed") {
          if (part.state.time.compacted) continue
          const loaded = part.state.metadata?.loaded
          if (!loaded || !Array.isArray(loaded)) continue
          for (const p of loaded) {
            if (typeof p === "string") paths.add(p)
          }
        }
      }
    }
    return paths
  }

  export async function find(dir: string) {
    for (const file of FILES) {
      const filepath = path.resolve(path.join(dir, file))
      if (await Bun.file(filepath).exists()) return filepath
    }
  }

  export async function resolve(messages: MessageV2.WithParts[], filepath: string, messageID: string) {
    // The same path set system() injected, so a file that appeared since is not skipped as already loaded
    const system = state().paths ?? (await systemPaths())
    const already = loaded(messages)
    const results: { filepath: string; content: string }[] = []

    const target = path.resolve(filepath)
    let current = path.dirname(target)
    const root = path.resolve(Instance.directory)

    while (current.startsWith(root) && current !== root) {
      const found = await find(current)

      if (found && found !== target && !system.has(found) && !already.has(found) && !isClaimed(messageID, found)) {
        claim(messageID, found)
        const content = await Bun.file(found)
          .text()
          .catch(() => undefined)
        if (content) {
          results.push({ filepath: found, content: "Instructions from: " + formatPath(found) + "\n" + content })
        }
      }
      current = path.dirname(current)
    }

    return results
  }
}
