import { Log } from "@/util/log"
import { Context } from "../util/context"
import { Project } from "./project"
import { State } from "./state"
import { iife } from "@/util/iife"
import { GlobalBus } from "@/bus/global"
import { Filesystem } from "@/util/filesystem"

interface Context {
  directory: string
  worktree: string
  project: Project.Info
}
const context = Context.create<Context>("instance")
const cache = new Map<string, Promise<Context>>()

const disposal = {
  all: undefined as Promise<void> | undefined,
}

export const Instance = {
  async provide<R>(input: { directory: string; init?: () => Promise<any>; fn: () => R }): Promise<R> {
    let existing = cache.get(input.directory)
    if (!existing) {
      Log.Default.info("creating instance", { directory: input.directory })
      existing = iife(async () => {
        const { project, worktree } = await Project.fromDirectory(input.directory)
        const ctx = {
          directory: input.directory,
          worktree,
          project,
        }
        await context.provide(ctx, async () => {
          await input.init?.()
        })
        return ctx
      })
      cache.set(input.directory, existing)
    }
    const ctx = await existing
    return context.provide(ctx, async () => {
      return input.fn()
    })
  },
  // Whether an instance for the directory exists, without creating one.
  cached(directory: string) {
    return cache.has(directory)
  },
  get directory() {
    return context.use().directory
  },
  get worktree() {
    return context.use().worktree
  },
  get project() {
    return context.use().project
  },
  /**
   * Check if a path is within the project boundary.
   * Returns true if path is inside Instance.directory OR Instance.worktree.
   * Paths within the worktree but outside the working directory should not trigger external_directory permission.
   */
  containsPath(filepath: string) {
    if (Filesystem.contains(Instance.directory, filepath)) return true
    return Filesystem.contains(Instance.worktree, filepath)
  },
  state<S>(init: () => S, dispose?: (state: Awaited<S>) => Promise<void>) {
    return State.create(() => Instance.directory, init, dispose)
  },
  async dispose() {
    const directory = Instance.directory
    Log.Default.info("disposing instance", { directory })
    // Ping daemons live at module scope in session/ping.ts, outside State, so
    // State.dispose below does not reach them. Stop them first, before their
    // subsystems tear down. Dynamic import: ping.ts imports Instance, so a
    // top-level import here would be circular.
    const { SessionPing } = await import("@/session/ping")
    SessionPing.stopForDirectory(directory)
    await State.dispose(directory)
    cache.delete(directory)
    GlobalBus.emit("event", {
      directory,
      payload: {
        type: "server.instance.disposed",
        properties: {
          directory,
        },
      },
    })
  },
  // Dispose a specific directory's instance ONLY if it is already cached. Unlike
  // provide()+dispose(), this never creates (and never bootstraps) a fresh
  // instance for an uncached directory — which would re-add the project to the
  // open set via InstanceBootstrap. The optional before() runs in the instance
  // context just prior to disposal (e.g. to stop sessions, which read
  // per-instance state). Used by project close.
  async disposeDirectory(directory: string, before?: () => void | Promise<void>) {
    const existing = cache.get(directory)
    if (!existing) return
    const ctx = await existing.catch(() => undefined)
    if (!ctx) {
      cache.delete(directory)
      return
    }
    if (cache.get(directory) !== existing) return
    await context.provide(ctx, async () => {
      await before?.()
      await Instance.dispose()
    })
  },
  async disposeAll() {
    if (disposal.all) return disposal.all

    disposal.all = iife(async () => {
      Log.Default.info("disposing all instances")
      const entries = [...cache.entries()]
      for (const [key, value] of entries) {
        if (cache.get(key) !== value) continue

        const ctx = await value.catch((error) => {
          Log.Default.warn("instance dispose failed", { key, error })
          return undefined
        })

        if (!ctx) {
          if (cache.get(key) === value) cache.delete(key)
          continue
        }

        if (cache.get(key) !== value) continue

        await context.provide(ctx, async () => {
          await Instance.dispose()
        })
      }
    }).finally(() => {
      disposal.all = undefined
    })

    return disposal.all
  },
}
