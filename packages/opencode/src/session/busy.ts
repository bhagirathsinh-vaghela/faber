import { Liveness } from "@/project/liveness"
import { Instance } from "@/project/instance"
import { Bus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import { BusEvent } from "@/bus/bus-event"
import { Event as ServerEvent } from "@/server/event"
import { SessionRecent } from "./recent"
import z from "zod"

// The single source of truth for "is a session working". Busy is NOT a stored
// latch that someone flips on and hopefully flips off — it is DERIVED from the
// one concrete in-flight handle: SessionPrompt holds an AbortController per
// running turn, and a turn is in flight iff that entry exists. `enter`/`exit`
// mirror those two membership mutations here. There is no "forgot to clear"
// case (the entry is deleted on every loop exit via defer, and dies with the
// process on crash), so no watchdog is needed.
//
// A session is busy for two independent reasons, and the parent indicators
// animate differently for each:
//   - self:        this session's OWN turn is in flight.
//   - descendants: some session anywhere BELOW it (subtask, or subtask of a
//                  subtask — full subtree) has its own turn in flight.
// The projection carries `busy` = self || descendants and `busySelf` = self, so
// the client derives descendants as `busy && !busySelf` where it needs the
// distinction.
//
// Busy reaches clients by three channels, all fed from this one source:
//   - Web overview: the recent-hub stamp below (recent.updated ships the full
//     hub list each emit — level-triggered, heals roots).
//   - Web session view: the per-connection 5s reconcile tick in /global/event
//     reads `subtreeSnapshot()` (level-triggered, heals the open subtree incl.
//     children, which aren't in the hub).
//   - Legacy TUI: the per-session `Event.Working` published below on the plain
//     Bus, which reaches the TUI's /event stream. Edge-triggered — acceptable
//     only because the TUI is a local single-user terminal (loopback, no mobile
//     drop/storm pressure) and bootstraps the open session's busy on attach.
//
// State is module-scoped (mirrors Liveness) and Instance-directory-keyed:
// children share their parent's directory, so a same-directory scan of the
// self-set resolves the whole tree without any cross-directory join.
export namespace SessionBusy {
  export const Event = {
    // Per-session busy transition for the TUI's /event stream (NOT the web,
    // which reads /global/event). Distinct type from the web's `session.busy`
    // snapshot event. Published from stamp() on change; deduped so a long turn
    // doesn't strobe it.
    Working: BusEvent.define(
      "session.working",
      z.object({
        sessionID: z.string(),
        busy: z.boolean(),
        busySelf: z.boolean(),
        busyDescendant: z.boolean(),
      }),
    ),
  }

  // Sessions whose OWN turn is in flight, per directory.
  const self = new Map<string, Set<string>>()
  // Child -> parent edges, per directory. Seeded from the parentID the prompt
  // loop already holds at turn start, so resolving an ancestor chain never
  // touches disk.
  const parent = new Map<string, Map<string, string>>()
  // Last {busy,busySelf} published on Event.Working per session, to dedupe the
  // TUI edge event so a long turn (many stamps) doesn't strobe it.
  const working = new Map<string, { busy: boolean; busySelf: boolean; busyDescendant: boolean }>()

  function selfSet(directory: string) {
    const set = self.get(directory) ?? new Set<string>()
    self.set(directory, set)
    return set
  }

  function edges(directory: string) {
    const map = parent.get(directory) ?? new Map<string, string>()
    parent.set(directory, map)
    return map
  }

  // Walk from a session up to the root, yielding it and every ancestor. Bounded
  // by a seen-set so a malformed cycle can't loop forever.
  function* chain(directory: string, sessionID: string) {
    const links = parent.get(directory)
    const seen = new Set<string>()
    let id: string | undefined = sessionID
    while (id && !seen.has(id)) {
      seen.add(id)
      yield id
      id = links?.get(id)
    }
  }

  // The three busy facts for a session:
  //   busySelf       — this session's OWN turn is in flight.
  //   busyDescendant — some session BELOW it (any depth) has its own turn in
  //                    flight. Resolved by walking each in-flight session's
  //                    ancestor chain and checking whether it passes through
  //                    this session — O(in-flight × depth), in-flight set tiny.
  //   busy           — busySelf || busyDescendant (the effective flag).
  // The client needs all three to pick own-only / both / delegating-only
  // visuals; busy+busySelf alone can't tell own-only from both.
  function facts(directory: string, sessionID: string) {
    const running = self.get(directory)
    const busySelf = running?.has(sessionID) ?? false
    let busyDescendant = false
    if (running && running.size > 0) {
      for (const id of running) {
        if (id === sessionID) continue
        for (const ancestor of chain(directory, id)) {
          if (ancestor === sessionID) {
            busyDescendant = true
            break
          }
        }
        if (busyDescendant) break
      }
    }
    return { busy: busySelf || busyDescendant, busySelf, busyDescendant }
  }

  // Stamp the durable channel: recent hub feeds the overview's list; Liveness
  // gates instance teardown. Called for a session and each ancestor on every
  // membership change. setBusy no-ops when unchanged, so restamping an
  // unaffected ancestor is cheap.
  function stamp(directory: string, sessionID: string) {
    const f = facts(directory, sessionID)
    void SessionRecent.setBusy(sessionID, f.busy, f.busySelf, f.busyDescendant)
    Liveness.setBusy(directory, sessionID, f.busy)
    // Per-session transition, published on change only. Drop the cache entry
    // when fully idle so the map can't grow without bound.
    const prev = working.get(sessionID)
    if (!prev || prev.busy !== f.busy || prev.busySelf !== f.busySelf || prev.busyDescendant !== f.busyDescendant) {
      // TUI channel: the plain Bus reaches the terminal's /event stream.
      Bus.publish(Event.Working, { sessionID, busy: f.busy, busySelf: f.busySelf, busyDescendant: f.busyDescendant })
      // Web channel: the same edge, as a single-entry session.busy frame the web
      // client's handler already writes to its store. Stamped "global" (like
      // recent.updated) because that handler lives only in the client's global
      // dispatch branch; the entry carries its own directory for store routing.
      // This makes a directly-opened subtask's indicator edge-triggered like a
      // root's, rather than waiting for the 5s reconcile tick. Rides the same
      // transition guard, so it fires once per busy on/off, not per step.
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: ServerEvent.Busy.type,
          properties: {
            sessions: {
              [sessionID]: { directory, busy: f.busy, busySelf: f.busySelf, busyDescendant: f.busyDescendant },
            },
          },
        },
      })
      if (f.busy) working.set(sessionID, { busy: f.busy, busySelf: f.busySelf, busyDescendant: f.busyDescendant })
      else working.delete(sessionID)
    }
  }

  // A turn started. Record the self flag + parent edge, then restamp this
  // session and every ancestor (each ancestor's descendant-busy just became
  // true).
  export function enter(sessionID: string, parentID?: string) {
    const directory = Instance.directory
    selfSet(directory).add(sessionID)
    if (parentID) edges(directory).set(sessionID, parentID)
    for (const id of chain(directory, sessionID)) stamp(directory, id)
  }

  // A turn ended. Clear the self flag, then restamp this session and every
  // ancestor so each ancestor's descendant-busy is recomputed. The edge is left
  // in place: it is cheap, harmless, and lets a re-prompt of the same child skip
  // re-seeding.
  export function exit(sessionID: string) {
    const directory = Instance.directory
    self.get(directory)?.delete(sessionID)
    for (const id of chain(directory, sessionID)) stamp(directory, id)
  }

  // Truth-source read for "is this session's own turn in flight". Mirrors the
  // SessionPrompt.state membership that assertNotBusy already gates on.
  //
  // A session id is unique across directories, so no directory is needed to
  // resolve one. Reading the ambient Instance instead would throw for a caller
  // running detached from any context.
  export function busy(sessionID: string) {
    for (const running of self.values()) if (running.has(sessionID)) return true
    return false
  }

  // Level-triggered reconcile snapshot for the 5s tick, scoped to ONE open
  // session's subtree (the only thing the tick heals: the open session + its
  // descendant subtasks, whose children the hub can't carry). Given the open
  // session id and its directory, walk the edge map for every descendant in that
  // directory and return FULL facts for the open id + each descendant (busy AND
  // idle) — authoritative by construction, so the client writes each straight
  // into the store with no omission inference. `directory` is stamped per entry
  // for routing (the tick frame is global, like recent.updated). Busy scope is
  // deliberately just "one session's subtree", never a cross-directory interest
  // set — a session is either in one session's view or the overview.
  export function subtreeSnapshot(sessionID: string, directory: string) {
    const links = parent.get(directory)
    const result: Record<string, { directory: string; busy: boolean; busySelf: boolean; busyDescendant: boolean }> = {}
    const put = (id: string) => {
      result[id] = { directory, ...facts(directory, id) }
    }
    put(sessionID)
    // Descendants: any session in this directory whose ancestor chain passes
    // through the open session. The edge map is tiny (only sessions that have
    // run a turn), and children share the parent's directory.
    if (links) {
      for (const id of links.keys()) {
        for (const ancestor of chain(directory, id)) {
          if (ancestor === sessionID && id !== sessionID) {
            put(id)
            break
          }
        }
      }
    }
    return result
  }

  // Does the given session's subtree have ANY busy session? Cheap quiescence
  // gate for the tick: with nothing busy in the open subtree, no snapshot need
  // be sent (beyond the single trailing all-idle when it clears).
  export function subtreeBusy(sessionID: string, directory: string) {
    return Object.values(subtreeSnapshot(sessionID, directory)).some((s) => s.busy)
  }

  // Every currently-busy session in the current instance, for the TUI's
  // bootstrap-on-attach (so its open session isn't stale before the first
  // Event.Working arrives). Only busy sessions appear; anything absent is idle.
  // A running session's ancestors are effective-busy too, so include them.
  export function list() {
    const directory = Instance.directory
    const running = self.get(directory)
    const result: Record<string, { busy: boolean; busySelf: boolean; busyDescendant: boolean }> = {}
    if (!running || running.size === 0) return result
    for (const id of running) {
      // Every running session + every ancestor is busy; facts() fills the
      // busySelf/busyDescendant split per node.
      for (const node of chain(directory, id)) result[node] = facts(directory, node)
    }
    return result
  }
}
