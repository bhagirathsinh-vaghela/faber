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
// The disk flush strips them; hydrate defaults them off except the debt counts,
// which it seeds from the debt table.
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
      // This session's OWN turn is in flight.
      turn: z.boolean(),
      // Open debts owed to this session by its subagents and by its background
      // jobs (SessionBusy.debts). Debts persist, so a restart shows them at
      // once; turns do not.
      subagents: z.number(),
      jobs: z.number(),
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
        turn: false,
        subagents: 0,
        jobs: 0,
        question: false,
        error: false,
        permission: false,
      })
    await seed()
  })

  // Debts persist across a restart and turns do not, so each entry's debt
  // counts are read from the debt table rather than left at 0.
  export async function seed() {
    const { SessionBusy } = await import("./busy")
    const { Debt } = await import("@/storage/debt")
    const callers = new Set((await Debt.list()).map((debt) => debt.caller))
    for (const entry of entries.values())
      if (callers.has(entry.sessionID)) Object.assign(entry, await SessionBusy.debts(entry.sessionID))
  }

  const sorted = () => [...entries.values()].sort((a, b) => b.updated - a.updated)

  let timer: ReturnType<typeof setTimeout> | undefined
  function flush() {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      const durable: Stored[] = sorted().map(
        ({ turn, subagents, jobs, question, error, permission, pingAt, ...rest }) => rest,
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
      "agent" | "turn" | "subagents" | "jobs" | "unseen" | "question" | "permission" | "error" | "pingAt"
    > & { agent?: string },
  ) {
    await hydrate()
    insert(input)
    // Recency only — the order moved, no actionable flag changed. Let it ride the
    // safety-net timer (or the next transition) instead of emitting per step.
    publishLazy()
  }

  function insert(input: Parameters<typeof touch>[0]) {
    const prev = entries.get(input.sessionID)
    entries.delete(input.sessionID)
    entries.set(input.sessionID, {
      ...input,
      agent: input.agent ?? prev?.agent,
      turn: prev?.turn ?? false,
      subagents: prev?.subagents ?? 0,
      jobs: prev?.jobs ?? 0,
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
  }

  // An unarchive is a membership change the user just asked for, so it goes out
  // at once instead of riding the recency-only lazy emit. Archiving dropped the
  // entry, so the caller supplies what it held: the unread dot and the live
  // flags. An entry older than the whole capped list is evicted by the insert.
  //
  // `still` and `flags` are called after the last await, in the same tick as
  // the insert, so an archive that lands while the caller gathers the rest wins
  // and the busy flags cannot be stale against the entry they are written to.
  export async function restore(
    input: Parameters<typeof touch>[0] & {
      unseen: boolean
      flags: () => Busy
      still: () => boolean
    },
  ) {
    const { unseen, flags, still, ...fields } = input
    await hydrate()
    if (!still()) return
    insert(fields)
    const entry = entries.get(input.sessionID)
    if (entry) Object.assign(entry, flags(), { unseen })
    publish()
  }

  type Busy = Pick<Entry, "turn" | "subagents" | "jobs">

  // Busy-fact flips. A missing entry means the session was never touched by a
  // turn or aged out of the cap, so the flip is irrelevant to the overview.
  export async function setBusy(sessionID: string, busy: Busy) {
    await hydrate()
    const entry = entries.get(sessionID)
    if (!entry || (entry.turn === busy.turn && entry.subagents === busy.subagents && entry.jobs === busy.jobs)) return
    Object.assign(entry, busy)
    publish()
  }

  // The roots the hub holds as working, for the overview heal tick to recompute.
  export async function active() {
    await hydrate()
    return [...entries.values()]
      .filter((entry) => entry.turn || entry.subagents > 0 || entry.jobs > 0)
      .map((entry) => entry.sessionID)
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
