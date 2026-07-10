import z from "zod"
import fs from "fs/promises"
import { Filesystem } from "../util/filesystem"
import path from "path"
import { $ } from "bun"
import { Storage } from "../storage/storage"
import { Log } from "../util/log"
import { Flag } from "@/flag/flag"
import { fn } from "@opencode-ai/util/fn"
import { BusEvent } from "@/bus/bus-event"
import { iife } from "@/util/iife"
import { GlobalBus } from "@/bus/global"

export namespace Project {
  const log = Log.create({ service: "project" })
  export const Info = z
    .object({
      id: z.string(),
      worktree: z.string(),
      vcs: z.literal("git").optional(),
      name: z.string().optional(),
      icon: z
        .object({
          url: z.string().optional(),
          override: z.string().optional(),
          color: z.string().optional(),
        })
        .optional(),
      commands: z
        .object({
          start: z.string().optional().describe("Startup script to run when creating a new workspace (worktree)"),
        })
        .optional(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        initialized: z.number().optional(),
      }),
      sandboxes: z.array(z.string()),
    })
    .meta({
      ref: "Project",
    })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define("project.updated", Info),
  }

  export async function fromDirectory(directory: string) {
    log.info("fromDirectory", { directory })

    // Identity IS the directory (canonicalized so /tmp and /private/tmp do not
    // fork into two projects). Git is detected only to resolve the worktree —
    // the up-tree ceiling for AGENTS.md/skills/config discovery, git ops, and
    // path relativization — and vcs. It no longer determines identity. A
    // non-git directory is its own worktree, so its up-walk stops at itself.
    const id = await fs.realpath(directory).catch(() => directory)

    const { worktree, vcs } = await iife(async () => {
      const matches = Filesystem.up({ targets: [".git"], start: id })
      const git = await matches.next().then((x) => x.value)
      await matches.return()
      if (!git) return { worktree: id, vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS) }

      const root = path.dirname(git)
      if (!Bun.which("git")) return { worktree: root, vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS) }

      const top = await $`git rev-parse --show-toplevel`
        .quiet()
        .nothrow()
        .cwd(root)
        .text()
        .then((x) => path.resolve(root, x.trim()))
        .catch(() => undefined)
      if (!top) return { worktree: root, vcs: "git" as const }

      const shared = await $`git rev-parse --git-common-dir`
        .quiet()
        .nothrow()
        .cwd(top)
        .text()
        .then((x) => {
          const parent = path.dirname(x.trim())
          return parent === "." ? top : parent
        })
        .catch(() => undefined)
      return { worktree: shared ?? top, vcs: "git" as const }
    })

    const existing = await Storage.read<Info>(["project", id]).catch(() => undefined)
    const result: Info = {
      id,
      worktree,
      vcs: vcs as Info["vcs"],
      name: existing?.name,
      icon: existing?.icon,
      commands: existing?.commands,
      time: {
        created: existing?.time.created ?? Date.now(),
        updated: Date.now(),
        initialized: existing?.time.initialized,
      },
      sandboxes: [],
    }

    if (Flag.OPENCODE_EXPERIMENTAL_ICON_DISCOVERY) discover(result)

    await Storage.write<Info>(["project", id], result)
    GlobalBus.emit("event", {
      payload: {
        type: Event.Updated.type,
        properties: result,
      },
    })
    return { project: result, sandbox: worktree }
  }

  export async function discover(input: Info) {
    if (input.vcs !== "git") return
    if (input.icon?.override) return
    if (input.icon?.url) return
    // Scan the project directory itself, not the worktree. Identity is the
    // directory, so a subfolder project's worktree is the whole repo root; a
    // recursive glob over that on every subfolder open is unbounded work for an
    // icon the subfolder doesn't own. For a repo opened at its root id ===
    // worktree, so root discovery is unchanged.
    const glob = new Bun.Glob("**/{favicon}.{ico,png,svg,jpg,jpeg,webp}")
    const matches = await Array.fromAsync(
      glob.scan({
        cwd: input.id,
        absolute: true,
        onlyFiles: true,
        followSymlinks: false,
        dot: false,
      }),
    )
    const shortest = matches.sort((a, b) => a.length - b.length)[0]
    if (!shortest) return
    const file = Bun.file(shortest)
    const buffer = await file.arrayBuffer()
    const base64 = Buffer.from(buffer).toString("base64")
    const mime = file.type || "image/png"
    const url = `data:${mime};base64,${base64}`
    await update({
      projectID: input.id,
      icon: {
        url,
      },
    })
    return
  }

  export async function setInitialized(projectID: string) {
    await Storage.update<Info>(["project", projectID], (draft) => {
      draft.time.initialized = Date.now()
    })
  }

  export async function list() {
    const keys = await Storage.list(["project"])
    const projects = await Promise.all(keys.map((x) => Storage.read<Info>(x)))
    return projects
  }

  export const update = fn(
    z.object({
      projectID: z.string(),
      name: z.string().optional(),
      icon: Info.shape.icon.optional(),
      commands: Info.shape.commands.optional(),
    }),
    async (input) => {
      const result = await Storage.update<Info>(["project", input.projectID], (draft) => {
        if (input.name !== undefined) draft.name = input.name
        if (input.icon !== undefined) {
          draft.icon = {
            ...draft.icon,
          }
          if (input.icon.url !== undefined) draft.icon.url = input.icon.url
          if (input.icon.override !== undefined) draft.icon.override = input.icon.override || undefined
          if (input.icon.color !== undefined) draft.icon.color = input.icon.color
        }

        if (input.commands?.start !== undefined) {
          const start = input.commands.start || undefined
          draft.commands = {
            ...(draft.commands ?? {}),
          }
          draft.commands.start = start
          if (!draft.commands.start) draft.commands = undefined
        }

        draft.time.updated = Date.now()
      })
      GlobalBus.emit("event", {
        payload: {
          type: Event.Updated.type,
          properties: result,
        },
      })
      return result
    },
  )

  // Sandboxes (git-worktree grouping) are deprecated: identity is the directory
  // now, so each worktree/subdirectory is already its own project. The field
  // stays on Info for schema stability, but is never populated. These helpers
  // are inert no-ops kept only so the git-worktree feature compiles.
  export async function sandboxes(_projectID: string): Promise<string[]> {
    return []
  }

  export async function addSandbox(_projectID: string, _directory: string) {}

  export async function removeSandbox(_projectID: string, _directory: string) {}
}
