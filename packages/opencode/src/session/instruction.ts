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

// Sits outside the FILES chain, which is first-match-wins: a fourth entry
// there would be shadowed by an AGENTS.md or CLAUDE.md in the same tree. A
// local file has to layer on top of whichever of those won, not replace it.
const LOCAL = "AGENTS.local.md"

// The header sits in S1 for a global file, ahead of every cache marker, so it
// must read the same from any directory. Scope decides the form rather than a
// prefix test: a global file is always home-relative, and only a project file
// is relative to the worktree. Testing the worktree first would rewrite a
// global file's header whenever the worktree contains home (cwd == ~), and
// testing home first would put the checkout path in a project file's header.
function formatPath(input: string, scope: "global" | "project") {
  const home = Global.Path.home
  const worktree = Instance.worktree
  if (scope === "project" && worktree !== "/" && Filesystem.contains(worktree, input)) {
    return path.relative(worktree, input)
  }
  if (input.startsWith(home + path.sep)) return `~/${path.relative(home, input)}`
  return input
}

function globalFiles() {
  const files = [path.join(Global.Path.config, "AGENTS.md")]
  if (!Flag.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT) {
    files.push(path.join(Global.Path.home, ".claude", "CLAUDE.md"))
  }
  if (Flag.OPENCODE_CONFIG_DIR) {
    files.push(path.join(Flag.OPENCODE_CONFIG_DIR, "AGENTS.md"))
  }
  return files
}

async function globalLocal() {
  const candidates = [path.join(Global.Path.config, LOCAL)]
  if (Flag.OPENCODE_CONFIG_DIR) candidates.push(path.join(Flag.OPENCODE_CONFIG_DIR, LOCAL))
  for (const candidate of candidates) {
    if (await Bun.file(candidate).exists()) return [path.resolve(candidate)]
  }
  return []
}

async function projectLocal() {
  if (Flag.OPENCODE_DISABLE_PROJECT_CONFIG) return []
  const matches = await Filesystem.findUp(LOCAL, Instance.directory, Instance.worktree).catch(() => [])
  return matches.map((match) => path.resolve(match))
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

    for (const file of await projectLocal()) paths.add(file)
    for (const file of await globalLocal()) paths.add(file)

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

    // Later text wins on conflict, so a local override cannot be sorted in
    // with the rest — alphabetical would place it ahead of AGENTS.md.
    const load = (paths: Set<string>, local: string[], scope: "global" | "project") =>
      [...[...paths].sort(), ...local.filter((p) => !paths.has(p)).sort()].map(async (p) => {
        const content = await Bun.file(p)
          .text()
          .catch(() => "")
        return content ? "Instructions from: " + formatPath(p, scope) + "\n" + content : ""
      })

    const globalLocals = await globalLocal()
    // Same rule for the local overrides: one found from both sides loads as global.
    const locals = {
      global: globalLocals,
      project: (await projectLocal()).filter((p) => !globalLocals.includes(p)),
    }
    const globalFiles_ = load(globalPaths, locals.global, "global")
    const projectFiles = load(projectPaths, locals.project, "project")

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
    cached.paths = new Set([...globalPaths, ...projectPaths, ...locals.global, ...locals.project])
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
    const found: string[] = []
    for (const file of FILES) {
      const filepath = path.resolve(path.join(dir, file))
      if (await Bun.file(filepath).exists()) {
        found.push(filepath)
        break
      }
    }
    const local = path.resolve(path.join(dir, LOCAL))
    if (await Bun.file(local).exists()) found.push(local)
    return found
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
      for (const found of await find(current)) {
        if (found === target || system.has(found) || already.has(found) || isClaimed(messageID, found)) continue
        claim(messageID, found)
        const content = await Bun.file(found)
          .text()
          .catch(() => undefined)
        if (content) {
          results.push({
            filepath: found,
            content: "Instructions from: " + formatPath(found, "project") + "\n" + content,
          })
        }
      }
      current = path.dirname(current)
    }

    return results
  }
}
