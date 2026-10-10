import path from "path"
import os from "os"
import { Instance } from "../project/instance"
import { Agent } from "../agent/agent"
import { Skill } from "../skill"
import { Command } from "../command"
import { Config } from "../config/config"
import { InstructionPrompt } from "./instruction"
import { ToolRegistry } from "../tool/registry"
import { MCP } from "../mcp"
import type { Tool } from "../tool/tool"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { Filesystem } from "../util/filesystem"

// Pin time = disk time. A session pins a snapshot of the prompt-shaping state
// on first touch (open or first turn after boot), and every turn reads through
// that pin — a RUNNING session never changes without consent. The consent
// gesture is Stop → reopen: drop() clears the pin and the next touch re-pins.
//
// Freshness is content-addressed, not event-driven: pin creation fingerprints
// the input files on disk (config chain, instructions, skills, commands,
// agents, custom tools) and looks the digest up in a snapshot pool. Identical
// disk state shares one snapshot across sessions (and one prompt-cache prefix);
// a changed disk misses the pool, resets the instance caches so the builders
// re-read disk, and builds a fresh snapshot. No reload button, no manual
// publish step. Pins are process-lifetime; a server restart clears everything.
export namespace SessionPin {
  export interface Snapshot {
    instructions: { global: string[]; project: string[] }
    agents: Record<string, Agent.Info>
    agentList: Agent.Info[]
    defaultAgent: string | undefined
    skills: Record<string, Skill.Info>
    commands: Record<string, Command.Info>
    toolsets: Record<string, string[]>
    custom: Tool.Info[]
  }

  interface Entry {
    snapshot: Snapshot
    sessions: Set<string>
  }

  // digest -> shared snapshot (refcounted by session membership)
  const pool = new Map<string, Entry>()
  // sessionID -> digest
  const pins = new Map<string, string>()
  // directory -> digest its snapshot-input caches were last built from; a
  // pool miss only resets the caches when this disagrees, so a refcount-freed
  // entry rebuilds without a redundant reset.
  const built = new Map<string, string>()

  // Re-read the snapshot inputs from disk WITHOUT Instance.dispose(): dispose
  // is directory-wide and its SessionPrompt callback aborts every running
  // turn — a new session opening after a disk edit must never kill a busy
  // sibling. These caches are lazy, so build() repopulates them. MCP.reset is
  // awaited because, unlike the pure in-memory memo-drops, it closes the live
  // MCP clients before dropping the memo so a config change picks up added/
  // removed servers on the next read (see MCP.reset).
  async function reset() {
    Config.global.reset()
    Config.state.reset()
    InstructionPrompt.reset()
    Agent.reset()
    Skill.state.reset()
    Command.reset()
    ToolRegistry.state.reset()
    await MCP.reset()
  }

  // Mirror of the scan surface in config.ts (loadCommand/loadAgent/loadMode/
  // loadPlugin) and skill.ts — the files whose CONTENT shapes a snapshot.
  const COMMAND_GLOB = new Bun.Glob("{command,commands}/**/*.md")
  const AGENT_GLOB = new Bun.Glob("{agent,agents}/**/*.md")
  const MODE_GLOB = new Bun.Glob("{mode,modes}/*.md")
  const SKILL_GLOB = new Bun.Glob("{skill,skills}/**/SKILL.md")
  const TOOL_GLOB = new Bun.Glob("{tool,tools,plugin,plugins}/*.{ts,js,mjs}")
  const EXTERNAL_SKILL_GLOB = new Bun.Glob("skills/**/SKILL.md")
  const PATH_SKILL_GLOB = new Bun.Glob("**/SKILL.md")
  const EXTERNAL_DIRS = [".claude", ".agents"]

  // Fresh walk every time — the memoized Config.directories() would miss a
  // .opencode dir created after the instance booted.
  async function directories() {
    const list = new Set<string>([Global.Path.config])
    if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
      for await (const dir of Filesystem.up({
        targets: [".opencode"],
        start: Instance.directory,
        stop: Instance.worktree,
      })) {
        list.add(dir)
      }
    }
    for await (const dir of Filesystem.up({
      targets: [".opencode"],
      start: Global.Path.home,
      stop: Global.Path.home,
    })) {
      list.add(dir)
    }
    if (Flag.OPENCODE_CONFIG_DIR) list.add(Flag.OPENCODE_CONFIG_DIR)
    return [...list]
  }

  async function scan(glob: Bun.Glob, cwd: string, into: Set<string>) {
    const matches = await Array.fromAsync(
      glob.scan({ cwd, absolute: true, onlyFiles: true, followSymlinks: true, dot: true }),
    ).catch(() => [] as string[])
    for (const match of matches) into.add(match)
  }

  // Only a skill's frontmatter shapes the prompt: name, description, and
  // location render into the skill tool's description and land in tools[]. The
  // body is tool OUTPUT, read from disk when the skill is invoked. So a
  // body edit is fingerprinted away, letting a running session pick up new
  // instructions on its next invocation while the cached prefix stands.
  async function skillDigestInput(file: string) {
    const text = await Bun.file(file)
      .text()
      .catch(() => undefined)
    if (text === undefined) return undefined
    const match = text.match(/^---\r?\n[\s\S]*?\r?\n---/)
    return new TextEncoder().encode(match ? match[0] : text)
  }

  // Everything on disk that shapes a snapshot. config.instructions and
  // skills.paths are resolved through the (possibly stale) config memo; the
  // config FILE bytes are always hashed directly, so a config edit that
  // changes those lists still changes the digest, and the rebuild it triggers
  // refreshes the memo — one converging extra rebuild, never a stale snapshot.
  // Managed enterprise config is excluded (admin-controlled; restart covers it).
  async function fingerprint() {
    const files = new Set<string>()
    for (const file of ["opencode.jsonc", "opencode.json", "config.json", "opencode.local.json"]) {
      files.add(path.join(Global.Path.config, file))
    }
    if (Flag.OPENCODE_CONFIG) files.add(Flag.OPENCODE_CONFIG)
    if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
      for (const file of ["opencode.jsonc", "opencode.json", "opencode.local.json"]) {
        for (const found of await Filesystem.findUp(file, Instance.directory, Instance.worktree)) {
          files.add(found)
        }
      }
    }

    for (const dir of await directories()) {
      for (const file of ["opencode.jsonc", "opencode.json"]) files.add(path.join(dir, file))
      for (const glob of [COMMAND_GLOB, AGENT_GLOB, MODE_GLOB, SKILL_GLOB, TOOL_GLOB]) {
        await scan(glob, dir, files)
      }
    }

    if (!Flag.OPENCODE_DISABLE_EXTERNAL_SKILLS) {
      const roots = EXTERNAL_DIRS.map((dir) => path.join(Global.Path.home, dir))
      for await (const root of Filesystem.up({
        targets: EXTERNAL_DIRS,
        start: Instance.directory,
        stop: Instance.worktree,
      })) {
        roots.push(root)
      }
      for (const root of roots) {
        if (!(await Filesystem.isDir(root))) continue
        await scan(EXTERNAL_SKILL_GLOB, root, files)
      }
    }

    const config = await Config.get()
    for (const skillPath of config.skills?.paths ?? []) {
      const expanded = skillPath.startsWith("~/") ? path.join(os.homedir(), skillPath.slice(2)) : skillPath
      const resolved = path.isAbsolute(expanded) ? expanded : path.join(Instance.directory, expanded)
      if (!(await Filesystem.isDir(resolved))) continue
      await scan(PATH_SKILL_GLOB, resolved, files)
    }

    for (const file of await InstructionPrompt.systemPaths()) files.add(file)

    const hasher = new Bun.CryptoHasher("sha256")
    hasher.update(Instance.directory + "\0")
    for (const file of [...files].sort()) {
      const content = file.endsWith("SKILL.md")
        ? await skillDigestInput(file)
        : await Bun.file(file)
            .bytes()
            .catch(() => undefined)
      if (!content) continue
      hasher.update(file + "\0")
      hasher.update(content)
      hasher.update("\0")
    }
    return hasher.digest("hex")
  }

  async function build(): Promise<Snapshot> {
    const [instructions, agents, skills, commands, toolsets, fallback, custom] = await Promise.all([
      InstructionPrompt.system(),
      Agent.list(),
      Skill.all(),
      Command.list(),
      Agent.toolsets(),
      Agent.defaultAgent().catch(() => undefined),
      ToolRegistry.state().then((x) => [...x.custom]),
    ])
    return {
      instructions,
      agents: Object.fromEntries(agents.map((a) => [a.name, a])),
      agentList: agents,
      defaultAgent: fallback,
      skills: Object.fromEntries(skills.map((s) => [s.name, s])),
      commands: Object.fromEntries(commands.map((c) => [c.name, c])),
      toolsets,
      custom,
    }
  }

  export async function get(sessionID: string): Promise<Snapshot> {
    const pinned = pins.get(sessionID)
    if (pinned) {
      const entry = pool.get(pinned)
      if (entry) return entry.snapshot
    }
    const digest = await fingerprint()
    const hit = pool.get(digest)
    if (hit) {
      hit.sessions.add(sessionID)
      pins.set(sessionID, digest)
      return hit.snapshot
    }
    // The input caches were built from an older disk state; reset them so the
    // builders re-read disk.
    if (built.get(Instance.directory) !== digest) {
      await reset()
      built.set(Instance.directory, digest)
    }
    const snapshot = await build()
    const entry = pool.get(digest) ?? { snapshot, sessions: new Set<string>() }
    pool.set(digest, entry)
    entry.sessions.add(sessionID)
    pins.set(sessionID, digest)
    return entry.snapshot
  }

  export function ensure(sessionID: string) {
    void get(sessionID)
  }

  // Drop the instance caches when disk has moved since they were built, without
  // pinning anything. A read (GET /config, GET /provider/default) has no session
  // to pin, so it cannot go through get(), and the memo would otherwise serve
  // pre-edit config until some session happened to touch this directory.
  // Announcing a digest move here would feed back: a client answers
  // global.disposed by re-bootstrapping every open directory, and each
  // bootstrap calls the readers that land here (GET /config,
  // GET /provider/default, GET /command).
  export async function refresh() {
    const digest = await fingerprint()
    if (built.get(Instance.directory) === digest) return
    await reset()
    built.set(Instance.directory, digest)
  }

  // Subagents must see the exact prompt state of their parent — a disk change
  // between parent turn and child spawn would otherwise split them.
  export function adopt(childID: string, parentID: string) {
    if (pins.has(childID)) return
    const digest = pins.get(parentID)
    if (!digest) return
    const entry = pool.get(digest)
    if (!entry) return
    entry.sessions.add(childID)
    pins.set(childID, digest)
  }

  export function drop(sessionID: string) {
    const digest = pins.get(sessionID)
    pins.delete(sessionID)
    if (!digest) return
    const entry = pool.get(digest)
    if (!entry) return
    entry.sessions.delete(sessionID)
    if (entry.sessions.size === 0) pool.delete(digest)
  }

  export function stats() {
    return { entries: pool.size, pins: pins.size }
  }
}
