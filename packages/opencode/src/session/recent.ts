import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { Storage } from "@/storage/storage"
import { lazy } from "@/util/lazy"
import z from "zod"

// An in-memory LRU of the sessions touched by a real turn, ordered by last
// activity. Server-owned so every client renders the same overview; persisted
// (lazily) so it survives a restart. Reads never scan the session store — the
// list is capped, held in memory, and written through to disk on a debounce.
// Lossy on purpose: a crash loses at most the last few touches, which only
// reorders a handful of recent entries.
//
// The entry is the full overview projection: alongside the durable recency it
// carries the live per-session flags the overview buckets on (busy, unseen) and
// the next-ping deadline. Those flags only ever flip for a session that a turn
// already touched, so the entry is present when they change — no join, no scan.
// They are instance-lifetime, so the disk flush strips them and hydrate defaults
// them off.
export namespace SessionRecent {
  const KEY = ["recent"]
  const LIMIT = 500
  // Lossy by design (see above), so the debounce trades a wider crash window for
  // fewer whole-list rewrites. The floor on that trade is the durable session
  // record: unseen is written there immediately by markUnseen/markSeen, so a
  // dropped flush costs recency ordering and a stale cached flag, never truth.
  const FLUSH_MS = 5000

  export const Entry = z
    .object({
      sessionID: z.string(),
      directory: z.string(),
      title: z.string(),
      // The agent that ran the session's last turn. The overview tints its
      // busy dot with this (agentColor), matching every other busy indicator;
      // absent for sessions last touched before this field existed.
      agent: z.string().optional(),
      // Last real-turn timestamp — the same signal that stamps session
      // lastActivity. Pings and views never reach here.
      updated: z.number(),
      // Effective busy: this session's own turn OR any in-flight descendant
      // subtask (full subtree). The single boolean isAlive reads.
      busy: z.boolean(),
      // This session's OWN turn only.
      busySelf: z.boolean(),
      // Any descendant subtask's own turn is in flight (full subtree). With
      // busySelf, lets the client pick own-only / both / delegating-only visuals
      // (busy+busySelf alone can't tell own-only from both).
      busyDescendant: z.boolean(),
      // A background job this session started is still running. Unlike the other
      // two busy flags, this is work the session is waiting on that no turn is
      // executing: the job outlives the turn that spawned it, so without this a
      // session with a twenty-minute build running looks idle.
      busyJob: z.boolean(),
      unseen: z.boolean(),
      // A question is pending an answer. Derived from the pending set rather
      // than counted, so a session with several open questions clears only when
      // the last one is answered.
      question: z.boolean(),
      // The last turn ended on an error. Cleared when the session is next
      // viewed or a new turn starts, so a red dot never outlives the failure
      // that earned it.
      error: z.boolean(),
      // A permission prompt is blocking the turn. Recomputed from the pending
      // set rather than counted, since one reply can resolve siblings: a
      // rejection drops every prompt on the session, an always-allow drops the
      // ones its new rule satisfies, and auto-accept drops the edit prompts.
      permission: z.boolean(),
      // Epoch ms the next cache ping fires; absent when no ping is scheduled.
      // The client renders the countdown from this against its own clock, so a
      // new deadline is the only thing that has to cross the wire.
      pingAt: z.number().optional(),
      // Dispatch time of the last successful ping — the forward-looking pingAt's
      // backward-looking counterpart. Recent sessions order on last interaction,
      // and a kept-warm session's pings are interaction even though they persist
      // no message and so never advance `updated`.
      pinged: z.number().optional(),
    })
    .meta({ ref: "RecentSession" })
  export type Entry = z.infer<typeof Entry>

  const Stored = Entry.pick({
    sessionID: true,
    directory: true,
    title: true,
    agent: true,
    updated: true,
    unseen: true,
    pinged: true,
  })
  type Stored = z.infer<typeof Stored>

  export const Event = {
    Updated: BusEvent.define("recent.updated", z.object({ entries: Entry.array() })),
  }

  const entries = new Map<string, Entry>()

  const hydrate = lazy(async () => {
    const stored = await Storage.read<Stored[]>(KEY).catch(() => [] as Stored[])
    for (const entry of stored)
      entries.set(entry.sessionID, {
        ...entry,
        busy: false,
        busySelf: false,
        busyDescendant: false,
        busyJob: false,
        question: false,
        error: false,
        permission: false,
      })
  })

  const sorted = () => [...entries.values()].sort((a, b) => b.updated - a.updated)

  let timer: ReturnType<typeof setTimeout> | undefined
  function flush() {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      const durable: Stored[] = sorted().map(
        ({ busy, busySelf, busyDescendant, busyJob, question, error, permission, pingAt, ...rest }) => rest,
      )
      void Storage.write(KEY, durable, { compact: true })
    }, FLUSH_MS)
  }

  // Emits split by how fresh the client needs them. A transition — busy on/off,
  // unseen dot, a ping countdown appearing or clearing — is actionable state and
  // publishes at once, so the overview learns it the instant the session view
  // does. Pure recency reordering and ping-deadline drift are not actionable (the
  // buckets and the shown countdown are unchanged; only sort order moves), and a
  // long turn fires one per assistant step seconds apart. Those mutate the map now
  // but only arm a slow safety-net timer, so the reordered list reaches clients
  // within LAZY_MS even if no transition happens to carry it sooner.
  const LAZY_MS = 2000
  let lazyTimer: ReturnType<typeof setTimeout> | undefined

  function emit() {
    GlobalBus.emit("event", {
      directory: "global",
      payload: { type: Event.Updated.type, properties: { entries: sorted() } },
    })
  }

  // A transition: emit the settled list immediately. Any pending lazy emit is now
  // redundant — this frame already carries the freshest order — so cancel it.
  function publish() {
    if (lazyTimer) {
      clearTimeout(lazyTimer)
      lazyTimer = undefined
    }
    emit()
  }

  // A non-actionable change (recency/drift): coalesce onto a single trailing emit.
  function publishLazy() {
    if (lazyTimer) return
    lazyTimer = setTimeout(() => {
      lazyTimer = undefined
      emit()
    }, LAZY_MS)
  }

  export async function list() {
    await hydrate()
    return sorted()
  }

  // A real turn touched this session: move it to the front and evict the oldest
  // past the cap. Live flags survive a re-touch so a busy turn that writes many
  // messages doesn't strobe the spinner off between chunks.
  export async function touch(
    input: Omit<
      Entry,
      | "agent"
      | "busy"
      | "busySelf"
      | "busyDescendant"
      | "busyJob"
      | "unseen"
      | "question"
      | "permission"
      | "error"
      | "pingAt"
    > & { agent?: string },
  ) {
    await hydrate()
    const prev = entries.get(input.sessionID)
    entries.delete(input.sessionID)
    entries.set(input.sessionID, {
      ...input,
      agent: input.agent ?? prev?.agent,
      busy: prev?.busy ?? false,
      busySelf: prev?.busySelf ?? false,
      busyDescendant: prev?.busyDescendant ?? false,
      busyJob: prev?.busyJob ?? false,
      unseen: prev?.unseen ?? false,
      question: prev?.question ?? false,
      permission: prev?.permission ?? false,
      // A fresh turn on this session supersedes the last one's failure.
      error: false,
      pingAt: prev?.pingAt,
      pinged: prev?.pinged,
    })
    if (entries.size > LIMIT) {
      const drop = sorted().slice(LIMIT)
      for (const entry of drop) entries.delete(entry.sessionID)
    }
    flush()
    // Recency only — the order moved, no actionable flag changed. Let it ride the
    // safety-net timer (or the next transition) instead of emitting per step.
    publishLazy()
  }

  // Live-flag flips. The entry is guaranteed present (the turn that set the flag
  // already touched it); a missing entry means the session aged out of the cap,
  // so the flip is irrelevant to the overview and dropped.
  export async function setBusy(sessionID: string, busy: boolean, busySelf: boolean, busyDescendant: boolean) {
    await hydrate()
    const entry = entries.get(sessionID)
    if (!entry || (entry.busy === busy && entry.busySelf === busySelf && entry.busyDescendant === busyDescendant))
      return
    entry.busy = busy
    entry.busySelf = busySelf
    entry.busyDescendant = busyDescendant
    publish()
  }

  // A job this session started began or ended. The per-edge setter is what
  // makes the flag land at the moment the job spawns rather than at the next
  // sweep, which is five minutes away and would leave a short job invisible for
  // its whole life.
  export async function setBusyJob(sessionID: string, busyJob: boolean) {
    await hydrate()
    const entry = entries.get(sessionID)
    if (!entry || entry.busyJob === busyJob) return
    entry.busyJob = busyJob
    publish()
  }

  // Derived from the job records rather than only toggled per edge: a job
  // outlives both the turn that started it and the process that spawned it, so
  // nothing held in memory has seen both ends. A flag with no running job behind
  // it is cleared by the pass that discovers it.
  export async function syncBusyJob(running: Set<string>) {
    await hydrate()
    for (const entry of entries.values()) {
      const next = running.has(entry.sessionID)
      if (entry.busyJob === next) continue
      entry.busyJob = next
      publish()
    }
  }

  export async function setUnseen(sessionID: string, unseen: boolean) {
    await hydrate()
    const entry = entries.get(sessionID)
    if (!entry || entry.unseen === unseen) return
    entry.unseen = unseen
    flush()
    publish()
  }

  // None of these three is durable: a question and a permission die with the
  // process holding their pending promise, and an error describes a turn this
  // instance ran.
  export async function setQuestion(sessionID: string, question: boolean) {
    await hydrate()
    const entry = entries.get(sessionID)
    if (!entry || entry.question === question) return
    entry.question = question
    publish()
  }

  export async function setPermission(sessionID: string, permission: boolean) {
    await hydrate()
    const entry = entries.get(sessionID)
    if (!entry || entry.permission === permission) return
    entry.permission = permission
    publish()
  }

  export async function setError(sessionID: string, error: boolean) {
    await hydrate()
    const entry = entries.get(sessionID)
    if (!entry || entry.error === error) return
    entry.error = error
    publish()
  }

  // A rename lands on the entry's title without moving its recency. Guaranteed
  // present like the flag flips: a session the overview shows was touched by a
  // turn; one it doesn't show needs no update. Title text is actionable — it's
  // what the overview renders — so emit at once.
  export async function setTitle(sessionID: string, title: string) {
    await hydrate()
    const entry = entries.get(sessionID)
    if (!entry || entry.title === title) return
    entry.title = title
    flush()
    publish()
  }

  export async function setPing(sessionID: string, pingAt: number | undefined) {
    await hydrate()
    const entry = entries.get(sessionID)
    if (!entry || entry.pingAt === pingAt) return
    // The countdown appearing or clearing is actionable and emits at once; a
    // deadline shifting while it stays present is drift the ticking client
    // absorbs, so it rides the lazy timer.
    const appearedOrCleared = entry.pingAt === undefined || pingAt === undefined
    entry.pingAt = pingAt
    if (appearedOrCleared) publish()
    if (!appearedOrCleared) publishLazy()
  }

  // A ping landed. Recency only — the Recent section's order moved, no flag the
  // overview renders changed — so it rides the lazy timer like touch() does.
  export async function setPinged(sessionID: string, at: number) {
    await hydrate()
    const entry = entries.get(sessionID)
    if (!entry) return
    entry.pinged = at
    flush()
    publishLazy()
  }

  export async function remove(sessionID: string) {
    await hydrate()
    if (!entries.delete(sessionID)) return
    flush()
    publish()
  }
}
