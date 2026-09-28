import { Session } from "@/session"
import { Instance } from "@/project/instance"
import { SessionRecent } from "@/session/recent"
import { Scheduler } from "@/scheduler"
import { Log } from "@/util/log"
import { BackgroundJob } from "./job"
import { BackgroundDeliver } from "./deliver"
import { BackgroundReconcile } from "./reconcile"
import { BackgroundSpawn } from "./spawn"

// Everything that decides when a job's result reaches a session.
//
// The job is dumb by design, so all of it lives here: three ways of learning
// that a job needs attention, one function that acts on it.
export namespace BackgroundOrchestrator {
  const log = Log.create({ service: "background-orchestrator" })

  // Long enough that a pass costs nothing, short enough that a job whose exit
  // both faster paths missed is not stranded for an hour.
  export const SWEEP_MS = 5 * 60 * 1000

  // How long after start-up ownership stops being deferred.
  //
  // Session liveness is rebuilt asynchronously after the server binds: the
  // supervisor re-arms daemons and resumes interrupted turns over the seconds
  // that follow. Until that has happened every session reads as not alive, and
  // an ownership verdict taken then kills healthy jobs (observed: a running job
  // reaped with reason=owner-gone while its owner was mid-restart).
  //
  // A window rather than a flag, because a sweep can be triggered by the abort
  // route or the exit watcher at any moment, including inside this window. A
  // flag set by the boot path would not cover those.
  export const SETTLE_MS = 60 * 1000

  const startedAt = Date.now()

  // Ownership is judged only once the view it depends on is real. Everything
  // else a sweep decides comes off disk and is correct immediately, so the
  // window delays one verdict rather than the whole pass.
  function settled(now = Date.now()) {
    return now - startedAt >= SETTLE_MS
  }

  // Whether a session could still read a result.
  //
  // The question is NOT "is this session working right now". A session sitting
  // idle is the ordinary case: its turn ended, the user will read the result
  // when the job finishes, and that is the whole point of a background job
  // outliving the turn that started it. Reaping on inactivity destroys exactly
  // the long-running work the design exists to protect.
  //
  // So EXISTENCE is the predicate. A session on disk can be opened and read; a
  // session that is gone cannot. `keepWarm` and `isAlive` both answer a
  // different, narrower question — whether a ping daemon is armed and whether a
  // turn is executing — and neither survives contact with an idle session:
  // `disarm` clears keepWarm on the ordinary ping tail, not only on a deliberate
  // Stop, so the flag means "armed right now" rather than "still wanted".
  //
  // The lookup runs inside the job's own directory. `Session.get` resolves its
  // project from an AsyncLocalStorage context, and a sweep reaches here from a
  // timer and from server start-up, neither of which has one — so without the
  // provide it throws for every job.
  //
  // Undefined, not false, when the answer cannot be established: `false` here
  // REAPS. A lookup that failed knows nothing about the user's intent, and
  // reading it as intent is what turns an infrastructure error into a killed
  // job. Nothing here returns `false` at all — a job whose session cannot be
  // read is deferred, and the job's own hard deadline is what bounds it.
  //
  // A miss and a real deletion are indistinguishable from here (both are
  // `Session.get` finding nothing), so this cannot safely emit the `false` that
  // the reconcile reap consumes. Reaping a stopped session's jobs is therefore
  // done directly at stop time (Session.stop -> BackgroundJob.stopSession), not
  // by an owner-gone verdict from here.
  export async function aliveFor(sessionID: string, directory: string): Promise<boolean | undefined> {
    return Instance.provide({
      directory,
      fn: async () => {
        // A miss is NOT a deletion. `Session.get` reads under
        // `Instance.project.id`, so a job whose recorded directory maps to a
        // different project (a `workdir` outside it, a moved checkout, a
        // cleaned /tmp) finds nothing — and reading that as "the user deleted
        // this session" reaps a healthy job. Letting it throw carries it to the
        // outer catch as undefined, which is the honest answer: unknown.
        await Session.get(sessionID)
        // EXISTENCE is the whole predicate. A session on disk can be opened and
        // read, whatever it is doing right now.
        return true
      },
    }).catch(() => undefined)
  }

  export function init() {
    // 1. The job this server spawned itself. The handle is already held, so
    //    its exit needs no polling and lands the instant it happens.
    //    Its session is paid here and now, in this process, which is the one
    //    whose person is attached; the pass covers everything else.
    BackgroundSpawn.watch(async (job) => {
      const { Recovery } = await import("@/session/recovery")
      await Recovery.collect(job.sessionID)
      await Recovery.poke()
    })

    // 2. A job this server ADOPTED, whose handle died with the previous one.
    //    The exit file is the job's last act, so watching for it is both the
    //    notification and the exit code.
    void BackgroundReconcile.observe(async (id) => {
      const job = await BackgroundJob.get(id)
      if (!job || job.status !== "running") return
      await sweep()
    })

    // 3. The backstop. Catches anything both fast paths missed: a deadline
    //    that passed while the server was down, a record whose spawn never
    //    landed, a job whose owner has since been stopped.
    //
    //    register() runs its task immediately as well as on the interval. That
    //    first run lands inside the settle window and defers ownership on its
    //    own, so it needs no special casing here.
    Scheduler.register({
      id: "background.reconcile",
      interval: SWEEP_MS,
      scope: "global",
      run: () => sweep(),
    })

    // 4. The nudge. A running job past its soft deadline gets a periodic
    //    check-in, on its own timer rather than the sweep's: the cadence is
    //    finer than a sweep interval, and the nudge does no process
    //    verification, so it must not wait on the sweep's heavier pass.
    Scheduler.register({
      id: "background.nudge",
      interval: BackgroundJob.NUDGE_MS,
      scope: "global",
      run: () => nudgeAll(),
    })
  }

  // Deliver a check-in for every running job that is due one. The claim on the
  // record is what bounds and paces this — decided per job in BackgroundJob.nudge
  // — so this reads the running set off disk (a job outlives the process that
  // spawned it, so a set held anywhere else would miss adopted ones) and asks
  // each for a nudge ordinal, delivering only when the claim is won.
  //
  // The record is RE-READ after the claim, not delivered from the pre-claim
  // copy: nudge() writes the new `nudges` count to disk, and the check-in prose
  // keys on it to say the first nudge's full contract once and the tighter
  // repeat after. Delivering the stale copy would render every second nudge with
  // the first one's text.
  export async function nudgeAll(now = Date.now()) {
    const running = (await BackgroundJob.list()).filter((job) => job.status === "running")
    for (const job of running) {
      const ordinal = await BackgroundJob.nudge(job.id, now)
      if (ordinal === undefined) continue
      const claimed = await BackgroundJob.get(job.id)
      // A check-in is progress, not a result: nothing is owed for it, so it
      // goes out directly and a lost one is simply the next nudge's to make.
      if (claimed)
        await BackgroundDeliver.send(claimed, "checkin").catch((error) =>
          log.error("check-in failed", { job: claimed.id, error }),
        )
    }
  }

  // One pass, acting on each verdict.
  //
  // Ownership is deferred for the first SETTLE_MS after start-up, whatever
  // triggered the pass. Everything derived from the JOB (it finished, it passed
  // its deadline, its record names no process) is decided from disk and is
  // correct immediately; ownership is the one verdict that reads live session
  // state, which is still being rebuilt.
  //
  // `adopting` forces that deferral for a caller that knows it is early, and
  // the window catches every other caller — including a sweep the abort route
  // or the exit watcher fires seconds into the window.
  export async function sweep(options: { adopting?: boolean } = {}) {
    const defer = options.adopting || !settled()
    if (defer) log.info("deferring the ownership verdict", { sinceStart: Date.now() - startedAt })
    const pass = await BackgroundReconcile.run({
      alive: defer ? () => true : aliveFor,
    })
    pass.actions
      .filter((action): action is Extract<BackgroundReconcile.Action, { type: "reaped" }> => action.type === "reaped")
      .forEach((action) => log.info("reaped", { job: action.job.id, reason: action.reason }))
    if (pass.actions.some((action) => action.type !== "reaped")) await poke()
    await BackgroundJob.cleanup()
    // AFTER the pass, so a job this sweep just settled reads as finished rather
    // than as one more tick of a spinner nobody is waiting on. Read from disk
    // for the same reason the pass is: a job outlives the process that spawned
    // it, so a set built anywhere else would miss the ones this server never saw
    // start.
    await SessionRecent.syncBusyJob(
      new Set((await BackgroundJob.list()).flatMap((job) => (job.status === "running" ? [job.sessionID] : []))),
    ).catch(() => undefined)
  }

  // Settled jobs are paid by recovery, inside the transaction that writes the
  // result, so a crash between settling and delivering loses nothing.
  async function poke() {
    const { Recovery } = await import("@/session/recovery")
    await Recovery.poke()
  }
}
