import { GlobalBus } from "@/bus/global"
import { Scheduler } from "@/scheduler"
import { Instance } from "@/project/instance"
import { Storage } from "@/storage/storage"
import { Identifier } from "@/id/id"
import { Log } from "@/util/log"
import { Session } from "./index"
import { SessionStatus } from "./status"
import { SessionBusy } from "./busy"
import { SessionPing } from "./ping"
import { SessionPrompt } from "./prompt"
import { MessageV2 } from "./message-v2"
import { SessionRecent } from "./recent"

// Delivering a helper session's result to the peer that asked for it.
//
// A spawned session is a CHILD in the supervision sense: something is waiting
// on it, so its termination has to reach that waiter. Leaving the child to
// report on its own makes delivery a courtesy — a helper that ends its turn
// without reporting strands the waiter, and nothing notices, which is the
// orphan an Erlang monitor and a Temporal child-workflow policy both exist to
// rule out. In both, the PARENT observes the child terminating rather than the
// child announcing itself.
//
// That is the shape here: the debt is recorded on the child's own record at
// spawn, and the runtime discharges it when the child goes idle. A child that
// never calls anything still reports.
export namespace SessionSpawn {
  const log = Log.create({ service: "session-spawn" })

  // How much of the child's answer travels. A report is the OUTCOME, not the
  // transcript: the waiter asked a question, and a peer's reasoning spends its
  // context on work it did not ask for.
  const MAX = 24_000

  // A child that idles more than once (a retry, a follow-up prompt someone
  // sends it) must not report again, so the debt is cleared before the write.
  // In-process too, since two idle events can land before the first write
  // settles.
  const settling = new Set<string>()

  // Subscribed on the GLOBAL bus, not the per-instance one. This runs at server
  // start-up, where there is no instance context to scope a subscription to, and
  // the sessions it must watch belong to whichever project they were spawned
  // under rather than to one. Every instance publish forwards here, so the
  // events are the same ones.
  //
  // Once per process. The global bus outlives every instance, so a second
  // init would leave two listeners on it and deliver each result twice.
  let watching = false

  // How often the debts are reconciled from disk. The idle event is the fast
  // path; this is what makes a missed one survivable.
  const SWEEP_MS = 60 * 1000

  // How long a delivery claim is honoured before another pass may take it over.
  // Long enough that a delivery in progress is never stolen, short enough that
  // a debt whose claimant died is picked up on the next sweep or two.
  const CLAIM_MS = 5 * 60 * 1000

  export function init() {
    if (watching) return
    watching = true

    // Level-triggered, because the event is not enough on its own. A helper
    // killed mid-turn, one that crashed, one deleted before it finished, and
    // one never prompted at all each leave a debt that no idle event will ever
    // discharge, and a parent flagged for a helper that will never report shows
    // a busy bar forever. This reads the debts off disk and decides each one
    // from the helper's actual state, so a restart heals rather than strands.
    //
    // register() runs immediately as well as on the interval, so start-up gets
    // a pass without a separate call.
    Scheduler.register({
      id: "session.spawn.reconcile",
      interval: SWEEP_MS,
      scope: "global",
      run: () => reconcile(),
    })

    GlobalBus.on("event", (event) => {
      if (event.payload?.type !== SessionStatus.Event.Idle.type) return
      const sessionID = event.payload.properties?.sessionID
      if (!sessionID) return
      void discharge(sessionID).catch((error) =>
        log.error("failed to deliver a spawned session's result", { sessionID, error }),
      )
    })
  }

  // One pass over every outstanding debt, decided from the record rather than
  // from an event having fired.
  //
  // Storage is read directly because this runs on a timer with no instance
  // context, and a debt can belong to any project. Every verdict here ends the
  // same way for the parent: either the result is delivered or the flag is
  // cleared, so no pass can leave a bar with nothing behind it.
  // Exported so a test can drive the timer path directly without relying on
  // the idle event, which would leave the backstop untested.
  export async function reconcile() {
    const keys = await Storage.list(["session"]).catch(() => [])
    for (const key of keys) {
      const session = await Storage.read<Session.Info>(key).catch(() => undefined)
      // A discharged record is kept for the resume path to read, so `done` is
      // what retires a debt here; the record's mere presence no longer does.
      if (!session?.spawn || session.spawn.done) continue
      // A helper mid-turn is working, and its idle event will discharge it.
      if (SessionBusy.busy(session.id)) continue
      // Under the helper's OWN directory. This runs from a timer, which has no
      // AsyncLocalStorage context, and `discharge` reads the session through
      // one: without this it throws, the throw is swallowed by the catch that
      // treats a missing session as nothing to do, and the pass silently heals
      // nothing at all.
      await Instance.provide({
        directory: session.directory,
        fn: () => discharge(session.id),
      }).catch((error) => log.error("failed to reconcile a spawned session", { sessionID: session.id, error }))
    }

    // The flag is DERIVED from the debts that are actually outstanding, not
    // merely toggled at each end. A parent absent from the recent list when its
    // helper was created (freshly made, or aged past the cap) would otherwise
    // never be flagged at all, since the setter has no entry to write to.
    // Reading it back from disk each pass also means a flag can never outlive
    // the debt that justified it.
    //
    // RE-READ, in a second pass over the records, AFTER every discharge above.
    // A set built during the loop describes the debts as they were before this
    // pass acted on them, so a debt discharged here would be re-asserted by the
    // derive at the end — the flag cleared and set again inside one pass, and
    // the parent left spinning on a report it already has until the next sweep.
    const owed = new Set<string>()
    for (const key of await Storage.list(["session"]).catch(() => [])) {
      const session = await Storage.read<Session.Info>(key).catch(() => undefined)
      if (!session?.spawn || session.spawn.done) continue
      owed.add(session.spawn.parent)
    }
    await SessionRecent.syncBusyHelper(owed)
  }

  // Retires the debt WITHOUT erasing the record: `done` is what a later reader
  // uses to tell a finished helper from an ordinary session. Removing the whole
  // record leaves the two indistinguishable, and the supervisor's resume then
  // sends a stopped helper a continue prompt, restarting its turn and re-arming
  // the daemon the discharge had just disarmed.
  function clear(sessionID: string) {
    return Session.update(sessionID, (draft) => {
      if (!draft.spawn) return
      draft.spawn.done = Date.now()
      draft.spawn.claimed = undefined
    })
  }

  async function discharge(sessionID: string) {
    if (settling.has(sessionID)) return
    // The turn's own handle is dropped before the status flips, so a child
    // that is still working (a tool call between turns) is not finished.
    if (SessionBusy.busy(sessionID)) return

    const child = await Session.get(sessionID).catch(() => undefined)
    if (!child?.spawn || child.spawn.done) return
    // Delivered by an earlier pass that crashed before retiring the debt. The
    // report is already in the parent's transcript, so this attempt is the
    // duplicate that at-least-once would otherwise produce, and it is dropped.
    if (child.spawn.delivered) {
      log.info("discarding a duplicate report", { child: sessionID, message: child.spawn.delivered })
      void SessionRecent.setBusyHelper(child.spawn.parent, false)
      await clear(sessionID)
      return
    }

    // The debt OUTLIVES the delivery attempt and is cleared only once the
    // report has landed. A crash between the two would otherwise lose a result
    // for good: the next pass would find no debt and conclude there was nothing
    // to send.
    //
    // The right to deliver is CLAIMED inside the write lock, the way a
    // reconcile pass claims a job. `settling` is a module-level set, so it
    // guards one process; two servers sharing the store (a staged cutover runs
    // both) would otherwise each read an unstamped debt, each deliver, and each
    // stamp, putting two reports in one transcript. Reading and writing under
    // one lock is what makes the check and the claim indivisible.
    settling.add(sessionID)
    let claimed = false
    const now = Date.now()
    await Session.update(sessionID, (draft) => {
      if (!draft.spawn) return
      // A claim older than the window belonged to a process that died holding
      // it. Taking it over is the only thing that keeps a crash from stranding
      // the debt for good.
      if (draft.spawn.claimed && now - draft.spawn.claimed < CLAIM_MS) return
      claimed = true
      draft.spawn.claimed = now
    })
    if (!claimed) {
      settling.delete(sessionID)
      return
    }
    const debt = child.spawn

    // TWO projects, not one. A session resolves only under its own, and the
    // helper and the peer waiting on it are not always in the same one — so the
    // helper's own reads (its answer, its teardown) run under `child.directory`
    // while the parent's (the lookup, the injected report) run under
    // `debt.directory`. Running either in the other's project finds nothing.
    const here = <T>(fn: () => Promise<T>) => Instance.provide({ directory: child.directory, fn })
    const there = <T>(fn: () => Promise<T>) => Instance.provide({ directory: debt.directory, fn })

    // Released rather than held: this pass delivered nothing, and holding the
    // claim would block every retry until it expired, which is the stall the
    // window exists to bound rather than to cause.
    const release = () =>
      here(() =>
        Session.update(sessionID, (draft) => {
          if (draft.spawn) draft.spawn.claimed = undefined
        }),
      )

    try {
      // A MISS IS NOT A DELETION. Reading an unresolved lookup as the user's
      // intent destroys a report whose reader is alive and waiting, and stops
      // the helper that produced it. The debt stays outstanding instead, the
      // same way an unresolved job owner defers rather than reaps.
      const parent = await there(() => Session.get(debt.parent).catch(() => undefined))
      if (!parent) {
        log.error("could not resolve the session to report to", {
          child: sessionID,
          parent: debt.parent,
          directory: debt.directory,
        })
        await release()
        return
      }

      // No answer YET is not the same as never: a helper created but not yet
      // replying, or between turns, still owes its report. Nothing is torn down
      // here, because the parent IS still waiting and the helper still has work
      // to do — clearing the flag would say otherwise, and stopping the helper
      // would end the turn about to produce the answer.
      //
      // ARCHIVED is the one case where never IS the answer. Archiving is how a
      // helper is cut off, and an archived session runs no further turn, so it
      // will never produce the text this pass is waiting for. Holding the debt
      // open leaves the parent flagged as waiting on work that cannot arrive,
      // and that flag outranks every other colour on the parent's spinner.
      const text = await here(() => summarize(sessionID, child.title))
      if (!text) {
        if (child.time.archived === undefined) {
          await release()
          return
        }
        log.info("retiring a debt no archived helper can pay", { child: sessionID, parent: debt.parent })
        void SessionRecent.setBusyHelper(debt.parent, false)
        await here(() => clear(sessionID))
        return
      }

      // Past here the report exists, so the helper is finished.
      void SessionRecent.setBusyHelper(debt.parent, false)
      const messageID = await there(() => inject(debt.parent, text))
      // STAMPED BEFORE THE STOP, and `delivered` before `done`. Two orderings
      // ride on this. A crash between the stamp and the retire leaves a pass
      // that sees a delivered report and discards its own attempt rather than
      // writing a second copy. And `done` is what keeps the daemon off: this
      // runs on the idle event, which fires while the turn is still unwinding,
      // so the turn's own tail arms one behind whatever the stop just disarmed.
      // Stopping first leaves a window where that arm sees no stamp yet.
      await here(async () => {
        await Session.update(sessionID, (draft) => {
          if (draft.spawn) draft.spawn.delivered = messageID
        })
        await clear(sessionID)
      })
      // The same teardown the Stop button performs, for the same reason: a
      // session left warm for a peer that is no longer waiting pings a cache on
      // nobody's behalf. Not a delete, since the transcript stays readable and
      // the parent may still have a follow-up.
      await here(() => Session.stop({ sessionID }))
      log.info("reported a spawned session's result", { child: sessionID, parent: debt.parent })

      // WAKING is what turns a delivered report into work, the same way a
      // delivered job result is woken. Written and not woken, the report sits in
      // the transcript as text until something else happens to start a turn:
      // the parent asked for the work, the answer arrived, and nothing acted on
      // it. That is the failure this whole mechanism exists to prevent, moved
      // one step later — from a peer that never reported to a spawner that never
      // read what it was sent.
      //
      // Last, after the stop and both stamps. The wake starts a turn in the
      // PARENT, so anything still to write on the helper has to be written
      // before a concurrent turn can reach either record.
      void there(() => SessionPrompt.loop(debt.parent)).catch((error) =>
        log.error("failed to wake the session a report was delivered to", { parent: debt.parent, error }),
      )
    } finally {
      settling.delete(sessionID)
    }
  }

  // The child's last assistant message, which is its answer. A helper that was
  // asked to do a bounded piece of work ends by stating the outcome, so the
  // final message is the report whether or not it thought to send one.
  async function summarize(sessionID: string, title: string) {
    const messages = await Session.messages({ sessionID })
    const last = messages.findLast((msg) => msg.info.role === "assistant")
    if (!last) return undefined
    const body = last.parts
      .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic)
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n\n")
      .trim()
    if (!body) return undefined
    const clipped = body.length > MAX ? `${body.slice(0, MAX)}\n\n[report truncated]` : body
    return [`## Report from ${title}`, "", clipped, "", `[reported by session ${sessionID}]`].join("\n")
  }

  async function inject(sessionID: string, text: string) {
    const messages = await Session.messages({ sessionID })
    const messageID = Identifier.ascending("message")
    const user = messages.findLast((msg) => msg.info.role === "user" && !msg.info.synthetic)?.info as
      | MessageV2.User
      | undefined
    await Session.updateMessage({
      id: messageID,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      ...(user
        ? MessageV2.inherit(user)
        : { agent: "build", model: { providerID: "unknown", modelID: "unknown" }, variant: undefined }),
      synthetic: true,
      promptIndex: messages.reduce((max, msg) => Math.max(max, msg.info.promptIndex ?? 0), 0) + 1,
    })
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID,
      sessionID,
      type: "text",
      text,
      synthetic: true,
    })
    return messageID
  }
}
