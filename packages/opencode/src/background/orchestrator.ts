import { isAlive } from "@opencode-ai/util/session"
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

  // Whether a session could still read a result, using the same predicate the
  // home overview classifies rows with: a turn in flight, or an armed
  // keepalive daemon. A deliberate Stop clears both and persists that, so a
  // stopped session reads as not alive here for the same reason it drops out
  // of the overview's live list.
  async function alive(sessionID: string) {
    const entry = (await SessionRecent.list()).find((row) => row.sessionID === sessionID)
    // A session too old to be in the recent hub cannot be waiting on anything.
    if (!entry) return false
    return isAlive(entry)
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
    Scheduler.register({
      id: "background.reconcile",
      interval: SWEEP_MS,
      scope: "global",
      run: sweep,
    })
  }

  // One pass, acting on each verdict. Safe to run at boot, on the timer, or
  // straight after a stop, because a record's fate depends only on its own
  // state.
  export async function sweep() {
    const pass = await BackgroundReconcile.run({ alive })
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
