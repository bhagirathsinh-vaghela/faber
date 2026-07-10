import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import z from "zod"

// The set of projects shown in every client's sidebar. Server-owned and
// pushed over SSE so all devices connected to one server render the same
// sidebar — the recent-hub model (session/recent.ts) applied to projects.
//
// In-memory only, no disk persistence: the set is derived from live sessions,
// not independently durable. A project is opened as a side effect of any first
// touch of its directory (which includes opening a session in it), and the
// supervisor resurrects busy/armed sessions across a restart — so the set
// reconstructs itself from those resurrected sessions. A project with no live
// session correctly does not survive a restart; nothing anchors it.
export namespace OpenProjects {
  export const Entry = z
    .object({
      id: z.string(),
      worktree: z.string(),
    })
    .meta({ ref: "OpenProject" })
  export type Entry = z.infer<typeof Entry>

  export const Event = {
    Updated: BusEvent.define("open-projects.updated", z.object({ entries: Entry.array() })),
  }

  const entries = new Map<string, Entry>()

  function emit() {
    GlobalBus.emit("event", {
      directory: "global",
      payload: { type: Event.Updated.type, properties: { entries: [...entries.values()] } },
    })
  }

  export function list() {
    return [...entries.values()]
  }

  export function has(id: string) {
    return entries.has(id)
  }

  export function open(entry: Entry) {
    const existing = entries.get(entry.id)
    if (existing && existing.worktree === entry.worktree) return
    entries.set(entry.id, entry)
    emit()
  }

  export function close(id: string) {
    if (!entries.delete(id)) return
    emit()
  }
}
