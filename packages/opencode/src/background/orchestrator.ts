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

  export function init() {
    // 1. The job this server spawned itself. The handle is already held, so
    //    its exit needs no polling and lands the instant it happens.
    //    Its session is paid here and now, in this process, which is the one
    //    whose person is attached; the pass covers everything else.
    BackgroundSpawn.watch(async (job) => {
      const { Recovery } = await import("@/session/recovery")
      await Recovery.collect(job.sessionID, { fresh: true })
      await poke()
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
  //
  // Only the lease holder checks in: a staged build reading the same records
  // would otherwise send each check-in a second time.
  export async function nudgeAll(now = Date.now()) {
    const { Recovery } = await import("@/session/recovery")
    if (!(await Recovery.lease())) return
    const running = (await BackgroundJob.list()).filter((job) => job.status === "running")
    await running.reduce(async (previous, job) => {
      await previous
      const nudge = await BackgroundJob.nudge(job.id, now)
      if (!nudge) return
      const claimed = await BackgroundJob.get(job.id)
      if (!claimed) return
      // A check-in is progress, not a result: nothing is owed for it, so it
      // goes out directly. A lost one hands its ordinal back, so the next
      // nudge says what this one would have.
      const sent = await BackgroundDeliver.checkin(claimed).catch((error) => {
        log.error("check-in failed", { job: claimed.id, error })
        return false
      })
      if (!sent) await BackgroundJob.retract(job.id, nudge)
    }, Promise.resolve())
  }

  // One pass, acting on each verdict. Everything it decides comes off disk (a
  // job finished, passed its deadline, or names no process) and is correct the
  // moment the server starts.
  export async function sweep() {
    const pass = await BackgroundReconcile.run()
    pass.actions
      .filter((action): action is Extract<BackgroundReconcile.Action, { type: "reaped" }> => action.type === "reaped")
      .forEach((action) => log.info("reaped", { job: action.job.id, reason: action.reason }))
    if (pass.actions.some((action) => action.type !== "reaped")) await poke()
    await BackgroundJob.cleanup()
  }

  // Settled jobs are paid by recovery, inside the transaction that writes the
  // result, so a crash between settling and delivering loses nothing. Only the
  // lease holder asks, so a staged build stays inert.
  async function poke() {
    const { Recovery } = await import("@/session/recovery")
    if (await Recovery.lease()) await Recovery.poke()
  }
}
