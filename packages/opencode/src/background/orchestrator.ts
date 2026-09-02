import { isAlive } from "@opencode-ai/util/session"
import { Session } from "@/session"
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
  // `isAlive` is the overview's predicate and answers "is this session working
  // RIGHT NOW", which is not the same question. Its terms live in memory and
  // are rebuilt after a restart, so during boot every session reads as not
  // alive — including one whose turn is about to be resumed.
  //
  // What survives a restart is `keepWarm`, the persisted shadow of the user's
  // intent. arm() writes it true, and it is cleared ONLY by a deliberate Stop
  // (via SessionPing.stop, which the abort route alone calls). So it is exactly
  // "has the user let this session go", which is the question a job's fate
  // turns on.
  //
  // Both are consulted: live work counts even on a session that was never
  // armed (ping can be disabled entirely), and persisted intent counts while
  // the live view is still being rebuilt.
  async function alive(sessionID: string) {
    const session = await Session.get(sessionID).catch(() => undefined)
    // Deleted outright. Nothing to deliver to and nothing to protect.
    if (!session) return false
    if (session.keepWarm) return true
    const entry = (await SessionRecent.list()).find((row) => row.sessionID === sessionID)
    return entry ? isAlive(entry) : false
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
    BackgroundReconcile.observe(async (id) => {
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
      alive: defer ? () => true : alive,
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
    // A result whose session is gone has nowhere to go. It stays on disk until
    // the age-based cleanup takes it, so reopening a session that crashed
    // still finds the output rather than re-running the work.
    if (!(await alive(job.sessionID))) {
      log.info("holding a result for a session that is not alive", { job: job.id, kind })
      return
    }
    await BackgroundDeliver.send(job, kind)
  }
}
