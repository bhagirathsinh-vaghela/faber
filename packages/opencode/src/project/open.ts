import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { Storage } from "@/storage/storage"
import { Filesystem } from "@/util/filesystem"
import { lazy } from "@/util/lazy"
import z from "zod"

// The set of projects shown in every client's sidebar. Server-owned and
// pushed over SSE so all devices connected to one server render the same
// sidebar — the recent-hub model (session/recent.ts) applied to projects.
//
// Persisted: the set is durable, not derived from live sessions. A project is
// opened as a side effect of any first touch of its directory (opening a
// session in it, attaching to a root session, finishing a turn) or explicitly,
// and it stays until the user explicitly closes it — surviving restarts and
// crashes. Membership is written through to the ["open-project", <id>] keyspace
// on open and removed on close; the set hydrates from disk on first use. The
// resume/rearm re-opens after a restart still fire but hit the no-op guard.
//
// `exists` is a live-computed flag, not stored: each list/emit stats the
// worktree so the sidebar can flag a project whose directory was deleted or
// moved (red, "Directory not found") without silently dropping it. Only an
// explicit close removes it.
export namespace OpenProjects {
  export const Entry = z
    .object({
      id: z.string(),
      worktree: z.string(),
      // Whether the worktree still resolves on disk. Computed at list/emit time,
      // never persisted. Absent on the durable record; always present on the
      // wire. false = the sidebar renders it as a not-found project.
      exists: z.boolean().optional(),
    })
    .meta({ ref: "OpenProject" })
  export type Entry = z.infer<typeof Entry>

  const Stored = Entry.pick({ id: true, worktree: true })
  type Stored = z.infer<typeof Stored>

  export const Event = {
    Updated: BusEvent.define("open-projects.updated", z.object({ entries: Entry.array() })),
  }

  const entries = new Map<string, Stored>()

  const hydrate = lazy(async () => {
    const keys = await Storage.list(["open-project"])
    const stored = await Promise.all(keys.map((key) => Storage.read<Stored>(key).catch(() => undefined)))
    for (const entry of stored) if (entry) entries.set(entry.id, entry)
  })

  // Stat each project's own directory (its id) so the wire snapshot carries
  // whether it still resolves; a subfolder project's worktree is the repo root.
  async function project() {
    return Promise.all(
      [...entries.values()].map(async (entry) => ({ ...entry, exists: await Filesystem.isDir(entry.id) })),
    )
  }

  async function emit() {
    GlobalBus.emit("event", {
      directory: "global",
      payload: { type: Event.Updated.type, properties: { entries: await project() } },
    })
  }

  export async function list() {
    await hydrate()
    return project()
  }

  export async function has(id: string) {
    await hydrate()
    return entries.has(id)
  }

  export async function open(entry: Stored) {
    await hydrate()
    const existing = entries.get(entry.id)
    if (existing && existing.worktree === entry.worktree) return
    entries.set(entry.id, entry)
    await Storage.write<Stored>(["open-project", entry.id], entry)
    await emit()
  }

  export async function close(id: string) {
    await hydrate()
    if (!entries.delete(id)) return
    await Storage.remove(["open-project", id])
    await emit()
  }
}
