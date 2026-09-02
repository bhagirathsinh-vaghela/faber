import { Session } from "@/session"
import { Instance } from "@/project/instance"
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
    BackgroundSpawn.watch(async (job) => {
      await deliver(job, job.status === "killed" ? "timeout" : "completed")
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
    for (const action of pass.actions) {
      if (action.type === "completed") await deliver(action.job, "completed")
      if (action.type === "expired") await deliver(action.job, "timeout")
      if (action.type === "notify") await deliver(action.job, "checkin")
      if (action.type === "reaped") log.info("reaped", { job: action.job.id, reason: action.reason })
    }
    await BackgroundJob.cleanup()
  }

  async function deliver(job: BackgroundJob.Info, kind: "completed" | "timeout" | "checkin") {
    // Only a session the user deliberately let go has its result held; an
    // unresolved lookup does not. Delivering into a session that turns out to
    // be gone costs a message nobody reads, while withholding on a failed
    // lookup loses the result of work that already ran.
    if ((await aliveFor(job.sessionID, BackgroundJob.owner(job))) === false) {
      log.info("holding a result for a session the user stopped", { job: job.id, kind })
      return
    }
    // A result that does not land is the one path that loses finished work for
    // good: the record settles either way, and reconcile returns early on a
    // settled record, so nothing sends it again. Nothing retries it here (the
    // lookup that just failed would fail identically on every later pass), but
    // it is recorded rather than dropped in silence.
    //
    // Two ways to fail, and only one of them is a return value. A session that
    // cannot be resolved reports false; anything past that point (building the
    // message, writing the part, cleaning a revert) THROWS. Both end with a
    // result nobody will read, so both are caught here.
    //
    // Caught HERE rather than around the caller's loop, because the throw is
    // one job's problem and the loop is every other job's delivery: an
    // uncaught one abandons the rest of the pass and skips the cleanup that
    // follows it. The exit watcher is worse off still, since it is invoked
    // from a floating promise where a throw is an unhandled rejection.
    const failure = await BackgroundDeliver.send(job, kind).then(
      (delivered) => (delivered ? undefined : "no session to deliver it to"),
      (error) => error,
    )
    if (!failure) return

    log.error("lost a result", {
      job: job.id,
      kind,
      sessionID: job.sessionID,
      project: BackgroundJob.owner(job),
      failure,
    })
    // The stamp is the durable half of the record above, so a failure to write
    // it must not itself throw and take the pass down.
    await BackgroundJob.update(job.id, (draft) => {
      draft.time.lost = Date.now()
    }).catch((error) => log.error("could not stamp a lost result", { job: job.id, error }))
  }
}
