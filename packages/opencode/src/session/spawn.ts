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
  async function reconcile() {
    const keys = await Storage.list(["session"]).catch(() => [])
    for (const key of keys) {
      const session = await Storage.read<Session.Info>(key).catch(() => undefined)
      if (!session?.spawn) continue
      // A helper mid-turn is working, and its idle event will discharge it.
      if (SessionBusy.busy(session.id)) continue
      await discharge(session.id).catch((error) =>
        log.error("failed to reconcile a spawned session", { sessionID: session.id, error }),
      )
    }
  }

  function clear(sessionID: string) {
    return Session.update(sessionID, (draft) => {
      draft.spawn = undefined
    })
  }

  async function discharge(sessionID: string) {
    if (settling.has(sessionID)) return
    // The turn's own handle is dropped before the status flips, so a child
    // that is still working (a tool call between turns) is not finished.
    if (SessionBusy.busy(sessionID)) return

    const child = await Session.get(sessionID).catch(() => undefined)
    if (!child?.spawn) return
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
    // to send. Delivery is therefore at-least-once, and the duplicate that
    // ordering admits is what `settling` and the busy check below rule out
    // within a process.
    settling.add(sessionID)
    const debt = child.spawn

    try {
      await Instance.provide({
        directory: debt.directory,
        fn: async () => {
          // Cleared on EVERY path out of here, including the ones that deliver
          // nothing: a parent left flagged for a helper that will never report
          // shows a busy bar forever, and a signal that cannot clear is one a
          // reader learns to ignore.
          void SessionRecent.setBusyHelper(debt.parent, false)

          // The same teardown the Stop button performs, for the same reason: a
          // helper whose result has been delivered is finished, and a session
          // left warm for a peer that is no longer waiting pings a cache on
          // nobody's behalf. Not a delete — the transcript stays readable, and
          // the parent may still have a follow-up for it.
          //
          // Stopping is the parent's call rather than the child's, which is the
          // close policy a Temporal parent applies to a completed child: a
          // child that shut itself down could not answer that follow-up.
          await Session.stop({ sessionID })

          const parent = await Session.get(debt.parent).catch(() => undefined)
          if (!parent) {
            // Nothing will ever receive this, so the debt is retired rather
            // than retried on every pass forever.
            log.error("no session to report to", { child: sessionID, parent: debt.parent })
            await clear(sessionID)
            return
          }
          const text = await summarize(sessionID, child.title)
          // No answer YET is not the same as never: a helper that has been
          // created but has not replied, or is between turns, still owes its
          // report. The debt stays, and a later pass delivers once there is
          // something to deliver.
          if (!text) return
          const messageID = await inject(debt.parent, text)
          // Stamped BEFORE the debt is retired, so the window a crash can land
          // in is one where the next pass sees a delivered report and discards
          // its own attempt rather than writing a second copy.
          await Session.update(sessionID, (draft) => {
            if (draft.spawn) draft.spawn.delivered = messageID
          })
          await clear(sessionID)
          log.info("reported a spawned session's result", { child: sessionID, parent: debt.parent })
        },
      })
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
