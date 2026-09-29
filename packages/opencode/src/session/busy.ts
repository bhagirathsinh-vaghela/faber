import { Liveness } from "@/project/liveness"
import { Instance } from "@/project/instance"
import { GlobalBus } from "@/bus/global"
import { Event as ServerEvent } from "@/server/event"
import { Debt } from "@/storage/debt"
import { Jobs } from "@/storage/jobs"
import { Sessions } from "@/storage/sessions"
import { SessionRecent } from "./recent"

// The single source of truth for "is a session working". Its facts are each
// derived from a concrete thing rather than a latch someone must remember to
// clear:
//   - turn:      this session's OWN turn is in flight. SessionPrompt holds an
//                AbortController per running turn; `enter`/`exit` mirror its
//                membership, so the flag dies with the handle.
//   - subagents: open debts a child session owes this session.
//   - jobs:      open debts a background job owes this session.
// A parent lights for its subagents through its own children's debts, never
// through a walk of their turns.
//
// Every change reaches clients through `push`: turn edges here, and every debt
// write after it commits. The push updates the recent-hub entry (the overview)
// and emits a single-entry `session.busy` frame. The /global/event heal tick
// re-sends `session.busy` facts while anything in a connection's scope is
// active (the open session plus children with an open debt or a live turn and
// one trailing zero for a child that just went idle, or each active root on the
// overview), so a dropped frame heals within one tick.
export namespace SessionBusy {
  export type Facts = { turn: boolean; subagents: number; jobs: number }

  // Sessions whose OWN turn is in flight, per directory.
  const self = new Map<string, Set<string>>()

  // A turn started.
  export function enter(sessionID: string) {
    const directory = Instance.directory
    const running = self.get(directory) ?? new Set<string>()
    self.set(directory, running)
    running.add(sessionID)
    Liveness.setBusy(directory, sessionID, true)
    void push(sessionID)
  }

  // A turn ended.
  export function exit(sessionID: string) {
    const directory = Instance.directory
    const was = self.get(directory)?.delete(sessionID) ?? false
    Liveness.setBusy(directory, sessionID, false)
    void push(sessionID)
    if (was) for (const listener of idle) listener(sessionID)
  }

  // Called once per turn that ends in this process, whatever ended it.
  const idle = new Set<(sessionID: string) => void>()
  export function onIdle(listener: (sessionID: string) => void) {
    idle.add(listener)
    return () => idle.delete(listener)
  }

  // Whether this session's own turn is in flight. A session id is unique
  // across directories, and a turn is keyed by the directory its prompt
  // request named, so every directory is consulted; reading the ambient
  // Instance instead would throw for a caller detached from any context.
  export function busy(sessionID: string) {
    for (const running of self.values()) if (running.has(sessionID)) return true
    return false
  }

  // A caller's open debts by kind. A debt whose job record or child session
  // is gone is left out, as Recovery.debts leaves it.
  export async function debts(caller: string, session?: Awaited<ReturnType<typeof Sessions.read>>) {
    const [record, owed, job, child] = await Promise.all([
      session ?? Sessions.read(caller).catch(() => undefined),
      Debt.owed(caller),
      Jobs.reader(),
      Sessions.reader(),
    ])
    if (!record) return { subagents: 0, jobs: 0 }
    return {
      subagents: owed.filter((debt) => debt.kind === "subagent" && child(debt.responder)).length,
      jobs: owed.filter((debt) => debt.kind === "job" && job(debt.responder)).length,
    }
  }

  // The facts for each id that still has a session, with the directory its
  // record names so the client routes the entry to the right store.
  export async function snapshot(ids: string[]) {
    const rows = await Promise.all(
      ids.map(async (id) => {
        const session = await Sessions.read(id).catch(() => undefined)
        if (!session) return undefined
        const facts: Facts = { turn: busy(id), ...(await debts(id, session)) }
        return [id, { directory: session.directory, ...facts }] as const
      }),
    )
    return Object.fromEntries(rows.filter((row) => row !== undefined))
  }

  export function active(facts: Facts) {
    return facts.turn || facts.subagents > 0 || facts.jobs > 0
  }

  // Every active session on the server: a session is active only through its
  // own turn or a debt owed to it, so the rest are idle and this is complete.
  export async function live() {
    const turning = [...self.values()].flatMap((running) => [...running])
    const sessions = await snapshot([...new Set([...turning, ...(await Debt.callers())])])
    return Object.fromEntries(Object.entries(sessions).filter(([, entry]) => active(entry)))
  }

  // Serialized per session, so two pushes racing on one session cannot emit
  // an older reading after a newer one.
  const queue = new Map<string, Promise<void>>()

  export function push(sessionID: string) {
    const next = (queue.get(sessionID) ?? Promise.resolve())
      .then(() => emit(sessionID))
      .catch(() => undefined)
      .finally(() => {
        if (queue.get(sessionID) === next) queue.delete(sessionID)
      })
    queue.set(sessionID, next)
    return next
  }

  async function emit(sessionID: string) {
    const sessions = await snapshot([sessionID])
    const entry = sessions[sessionID]
    if (!entry) return
    await SessionRecent.setBusy(sessionID, { turn: entry.turn, subagents: entry.subagents, jobs: entry.jobs })
    // Stamped "global" like recent.updated: the client's handler lives only in
    // its global dispatch branch, and the entry carries its own directory.
    GlobalBus.emit("event", {
      directory: "global",
      payload: { type: ServerEvent.Busy.type, properties: { sessions } },
    })
    // The hub holds roots; re-reading the caller's root there means a missed
    // or out-of-order root update is corrected by any change below it.
    const root = await rootOf(sessionID)
    if (root === sessionID) return
    const top = (await snapshot([root]))[root]
    if (top) await SessionRecent.setBusy(root, { turn: top.turn, subagents: top.subagents, jobs: top.jobs })
  }

  async function rootOf(sessionID: string, seen = new Set<string>()): Promise<string> {
    if (seen.has(sessionID)) return sessionID
    seen.add(sessionID)
    const session = await Sessions.read(sessionID).catch(() => undefined)
    if (!session?.parentID) return sessionID
    return rootOf(session.parentID, seen)
  }
}
