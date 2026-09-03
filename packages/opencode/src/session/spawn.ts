import { Scheduler } from "@/scheduler"
import { Storage } from "@/storage/storage"
import { Log } from "@/util/log"
import { Session } from "./index"
import { SessionRecent } from "./recent"

// The parent's "waiting on a helper" flag, kept honest from the debts on disk.
//
// A spawned session carries a debt on its own record (`spawn.parent`, set at
// spawn). Reporting is EXPLICIT: the child posts its result into the parent
// over the API and, in the same step, stamps its own `spawn.done` (the
// session.update route). The runtime does NOT infer completion from the
// child going idle, because idle is ambiguous — a restart-aborted turn, a pause
// between turns, and a genuine finish all look identical, and delivering on the
// first would ship an interim message and stop the child before its real answer
// exists. So the debt is retired only by the child saying so.
//
// This pass reads the debts off disk and derives the parent flag from them: a
// parent owed by a helper with no `done` shows the flag, one whose helpers have
// all reported does not. Nothing here delivers a report or touches the child.
export namespace SessionSpawn {
  const log = Log.create({ service: "session-spawn" })

  // Once per process. Scheduler is global, so a second register would run the
  // sweep twice.
  let watching = false

  const SWEEP_MS = 60 * 1000

  export function init() {
    if (watching) return
    watching = true
    // register() runs the task immediately as well as on the interval, so
    // start-up reconciles the flags without a separate call.
    Scheduler.register({
      id: "session.spawn.reconcile",
      interval: SWEEP_MS,
      scope: "global",
      run: () => reconcile(),
    })
  }

  // Derive each parent's helper flag from the debts still outstanding. Reading
  // it back from disk every pass is what keeps a flag from outliving the debt
  // that justified it, and from never being set for a parent that was absent
  // from the recent list when its helper was created.
  //
  // Storage is read directly because this runs from a timer with no instance
  // context, and a debt can belong to any project.
  export async function reconcile() {
    const owed = new Set<string>()
    for (const key of await Storage.list(["session"]).catch(() => [])) {
      const session = await Storage.read<Session.Info>(key).catch(() => undefined)
      if (!session?.spawn || session.spawn.done) continue
      owed.add(session.spawn.parent)
    }
    await SessionRecent.syncBusyHelper(owed).catch((error) => log.error("failed to sync helper flags", { error }))
  }
}
