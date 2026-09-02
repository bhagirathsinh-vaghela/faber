import { watch, type FSWatcher } from "fs"
import path from "path"
import { Log } from "@/util/log"
import { BackgroundJob } from "./job"
import { BackgroundProcess } from "./process"

// The server-side brain. Every decision about a job is taken here, by reading
// records off disk and looking at the process table — never from in-memory
// state, which a restarted server does not have.
//
// The job itself stays dumb: it runs a command, writes output and its own exit
// code, and enforces its own hard deadline. It reports nothing. So the only
// way a result reaches a session is a reconcile pass, which means a pass has
// to be correct with no help from whatever spawned the job.
export namespace BackgroundReconcile {
  const log = Log.create({ service: "background-reconcile" })

  // Whether the session that owns a job still exists in a form that could read
  // a result. Injected rather than imported so a pass can be driven in a test
  // with no session store, and so the caller decides what liveness means.
  //
  // UNDEFINED means the answer could not be established, and is NOT the same as
  // false. False is a verdict about the user's intent and reaps; undefined is a
  // failed lookup, which says nothing about intent and must leave the job alone.
  export type Alive = (sessionID: string, directory: string) => boolean | undefined | Promise<boolean | undefined>

  export type Action =
    | { type: "kept"; job: BackgroundJob.Info }
    | { type: "completed"; job: BackgroundJob.Info; exit: number | undefined }
    | { type: "expired"; job: BackgroundJob.Info }
    | { type: "reaped"; job: BackgroundJob.Info; reason: "owner-gone" | "orphaned" }
    | { type: "notify"; job: BackgroundJob.Info }

  export type Pass = {
    actions: Action[]
  }

  // One pass over every record. Safe to run at boot, on a timer, or right
  // after a stop: each record's fate depends only on its own state, so the
  // entry point changes nothing about the outcome.
  export async function run(input: { alive: Alive; now?: number }): Promise<Pass> {
    const now = input.now ?? Date.now()
    const actions: Action[] = []

    for (const job of await BackgroundJob.list()) {
      const action = await reconcile(job, input.alive, now)
      if (action) actions.push(action)
    }

    if (actions.length > 0) log.info("reconciled", { actions: actions.length })
    return { actions }
  }

  async function reconcile(job: BackgroundJob.Info, alive: Alive, now: number): Promise<Action | undefined> {
    // A record already past running has nothing left to decide; cleanup takes
    // it later on age, so its result stays readable until then.
    if (job.status !== "running") return undefined

    const verdict = await BackgroundJob.assess(job, now)

    // A record naming no process describes a spawn that never happened: the
    // server died between writing it and the spawn returning. Nothing to kill,
    // nothing to collect.
    if (verdict.type === "orphaned") {
      await BackgroundJob.remove(job.id)
      return { type: "reaped", job, reason: "orphaned" }
    }

    // The job finished while nobody was watching, which is the ordinary case
    // after a restart. Its output and exit code are already on disk.
    if (verdict.type === "finished") {
      const completed = await settle(job, "exited", verdict.exit, now)
      // Another pass settled it first and is delivering it, so this one keeps
      // the record and says nothing rather than delivering it twice.
      if (!completed) return { type: "kept", job }
      return { type: "completed", job: completed, exit: verdict.exit }
    }

    // Still running, so the owner decides whether it may continue. A job whose
    // session was deliberately stopped is work nobody will read.
    //
    // ONLY an explicit false reaps. An undefined answer means the lookup could
    // not run, which is a fact about this server rather than about the user's
    // intent, and killing on it destroys healthy work for an infrastructure
    // reason the job had nothing to do with.
    if ((await alive(job.sessionID, BackgroundJob.owner(job))) === false) {
      await BackgroundProcess.kill(verdict.identity)
      await BackgroundJob.remove(job.id)
      return { type: "reaped", job, reason: "owner-gone" }
    }

    // Past its hard deadline and still alive. The job's own watchdog should
    // have ended it, so reaching here means the watchdog itself was killed;
    // this is the backstop for that, not the primary mechanism.
    if (verdict.type === "expired") {
      await BackgroundProcess.kill(verdict.identity)
      const completed = await settle(job, "killed", await BackgroundJob.exit(job.id), now)
      if (!completed) return { type: "kept", job }
      return { type: "expired", job: completed }
    }

    // Alive, owned, inside its bound. The one thing left is the soft deadline,
    // whose check-in is delivered once: the stamp is what stops a pass every
    // few minutes from re-delivering it forever.
    // Claimed the same way as a settle, and for the same reason: the stamp is
    // what stops a pass every few minutes re-delivering the check-in forever,
    // so reading it outside the lock lets two passes both find it absent and
    // both deliver.
    if (job.time.soft && now >= job.time.soft && !job.time.notified) {
      let claimed = false
      await BackgroundJob.update(job.id, (draft) => {
        if (draft.time.notified) return
        claimed = true
        draft.time.notified = now
      })
      if (claimed) return { type: "notify", job }
    }

    return { type: "kept", job }
  }

  // Settling is what earns the right to deliver, so exactly one pass may do it
  // per job. Two passes can read the same running record — the exit watcher and
  // the abort route both sweep unguarded, and the scheduler's tick is not
  // re-entrant — and each would otherwise settle it and emit its own action,
  // putting two cards in the session for one job.
  //
  // The claim is made INSIDE the update, which takes a write lock on the
  // record, so the read and the write cannot be interleaved by a second pass.
  // Returning undefined means another pass got there first and this one has
  // nothing to deliver.
  async function settle(job: BackgroundJob.Info, status: BackgroundJob.Status, exit: number | undefined, now: number) {
    let claimed = false
    await BackgroundJob.update(job.id, (draft) => {
      if (draft.status !== "running") return
      claimed = true
      draft.status = status
      draft.exit = exit
      draft.time.completed = now
    })
    if (!claimed) return undefined
    return { ...job, status, exit, time: { ...job.time, completed: now } }
  }

  // Learning that an ADOPTED job has finished — one this server never spawned,
  // so it holds no process handle and cannot await anything.
  //
  // The kernel will not help directly: a reparented orphan's exit status goes
  // to init, so waitpid is unavailable to a non-parent, and the syscalls that
  // do report a non-child's death (pidfd_open on Linux 5.3+, kqueue
  // EVFILT_PROC on macOS) are per-platform, need FFI, and still report only
  // THAT it died, never with what code.
  //
  // The job's last act is writing its own exit file, so watching for that file
  // answers both questions at once with one portable API. Verified firing on
  // macOS (FSEvents) and Linux (inotify) alike.
  //
  // This is a wake-up, not a source of truth: the handler re-reads the record
  // and re-assesses, so a spurious event costs a cheap pass and a missed one
  // is caught by the next periodic pass.
  let watcher: FSWatcher | undefined

  export function observe(onFinished: (id: string) => void | Promise<void>) {
    watcher?.close()
    watcher = watch(BackgroundJob.dir, (_event, name) => {
      if (!name || !name.endsWith(".exit")) return
      void onFinished(path.basename(name, ".exit"))
    })
    // A watcher must never be the reason the process stays up.
    watcher.unref()
    return watcher
  }

  export function unobserve() {
    watcher?.close()
    watcher = undefined
  }
}
