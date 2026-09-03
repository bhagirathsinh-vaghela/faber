import path from "path"
import fs from "fs/promises"
import z from "zod"
import { Global } from "@/global"
import { Storage } from "@/storage/storage"
import { Log } from "@/util/log"
import { BackgroundProcess } from "./process"

// The durable record of a spawned shell job, and the files it writes.
//
// A job is spawned detached, so it survives the server that started it: a
// restart reparents it to init rather than killing it, and a 10-minute build
// must not die because the server was restarted to test something else. What
// the restart must NOT lose is CONTROL, which is what this record preserves.
// A replacement server reads these records back and can then verify, adopt,
// kill, or collect a job it never spawned.
//
// The job itself stays dumb. It runs the user's command and writes two files;
// it knows nothing about sessions, timeouts, or injection. Every decision is
// the server's, taken by reading these records.
export namespace BackgroundJob {
  const log = Log.create({ service: "background-job" })

  const PREFIX = ["background", "job"]

  // What the PROCESS did. Whether anyone read the result is a separate
  // question, answered by `time.lost`: a result nobody received still came
  // from a command that exited or was killed, and folding the two together
  // gives a state that describes neither.
  export const Status = z.enum(["running", "exited", "killed"])
  export type Status = z.infer<typeof Status>

  export const Info = z
    .object({
      id: z.string(),
      sessionID: z.string(),
      // Where the command RUNS, which a `workdir` argument can point anywhere.
      directory: z.string(),
      // Which project the owning session belongs to, and the only directory a
      // session lookup may use. `directory` can name somewhere outside the
      // project entirely, where the session resolves to nothing and its result
      // has nowhere to land. Absent on a record written before the split, whose
      // `directory` is the session's own.
      project: z.string().optional(),
      command: z.string(),
      description: z.string(),
      status: Status,
      // Identity survives the server, so a later sweep can prove the pid still
      // names this job before signalling it. Absent only in the window between
      // writing the record and the spawn returning.
      process: z
        .object({
          pid: z.number(),
          start: z.string(),
          pgid: z.number(),
        })
        .optional(),
      time: z.object({
        created: z.number(),
        // Deadlines, NOT timers. A setTimeout dies with the process that set
        // it, so a bound expressed as a timer silently lapses across a
        // restart. An absolute instant on disk is still true when a
        // replacement server reads it an hour later.
        soft: z.number().optional(),
        hard: z.number(),
        completed: z.number().optional(),
        // When the soft deadline's check-in was delivered, so a reconcile
        // that runs every few minutes does not re-deliver it.
        notified: z.number().optional(),
        // When a finished result could not be delivered. The work ran and its
        // output is still on disk; what is gone is the session that asked for
        // it, so the stamp is what distinguishes a result nobody read from one
        // that was never produced.
        //
        // It records ONE attempt, not a verdict: the record settles before
        // delivery is tried and a settled record is never reconciled again, so
        // a momentary fault (lock contention, a full disk) is stamped the same
        // as a session that will never exist again.
        lost: z.number().optional(),
      }),
      exit: z.number().optional(),
    })
    .meta({ ref: "BackgroundJob" })
  export type Info = z.infer<typeof Info>

  // Job output lives outside Storage: it is an append target for a process
  // that must keep writing after the server is gone, which a JSON record
  // cannot be. Results outlive their session on purpose, so reopening a
  // crashed session reads a finished job's output instead of re-running it.
  export const dir = path.join(Global.Path.data, "job")

  // Derived from the id rather than stored, so the paths are reconstructable
  // from a record alone and a half-written record cannot lose them.
  export function logPath(id: string) {
    return path.join(dir, id + ".log")
  }

  // A job that is SIGKILLed never reaches its own exit write, so the absence
  // of this file beside a gone process is itself information: the job died
  // without recording a status.
  export function exitPath(id: string) {
    return path.join(dir, id + ".exit")
  }

  export async function init() {
    await fs.mkdir(dir, { recursive: true })
  }

  // Where this job's session resolves. Every session read goes through here so
  // no caller has to remember which of the two directories a record carries is
  // the one a lookup may use.
  export function owner(job: Info) {
    return job.project ?? job.directory
  }

  // The session stops showing a running job once it has none left. Called by
  // every path that takes a record out of `running`, since a session with two
  // jobs must keep the flag while the second one runs.
  //
  // Shared rather than repeated: three paths settle a record (the exit watcher,
  // a reconcile pass, and a kill), and one predicate answering to three copies
  // is a predicate that holds in two of them.
  export async function settled(sessionID: string) {
    const running = await list().then((jobs) =>
      jobs.some((job) => job.sessionID === sessionID && job.status === "running"),
    )
    if (running) return
    const { SessionRecent } = await import("@/session/recent")
    void SessionRecent.setBusyJob(sessionID, false)
  }

  // v7 is time-ordered, so listing sorts oldest-first for free and the
  // age-based cleanup needs no stat call to decide what is oldest.
  export function id() {
    return Bun.randomUUIDv7()
  }

  // Wrap the user's command so the job enforces its own hard deadline and
  // records its own exit code.
  //
  // Self-enforcement is what makes the bound hold with NO server alive: a
  // sweep can only kill late, and only if something is running to do it. The
  // watchdog kills the command subtree on expiry, and whatever the command
  // wrote up to that point is already in the log, so a timed-out job still
  // reports partial output.
  //
  // Written as POSIX shell rather than `timeout`, which is not on a stock
  // macOS (it arrives with Homebrew coreutils, absent on a clean machine).
  //
  // The command runs in the BACKGROUND with an explicit wait, not inline: a
  // foreground command would make the shell replace itself, and the exit
  // write after it would never run.
  //
  // The command runs inside a NESTED `sh -c` that turns on job control for
  // itself. That placement is load-bearing twice over.
  //
  // Job control is what puts the command in a process group of its own, which
  // is what lets the watchdog signal `-$__oc_cmd` and take the whole subtree.
  // Without it the command shares the wrapper's group, so the watchdog reaches
  // only the direct child and a `make`'s compilers keep running.
  //
  // It has to be a nested `sh` because the OUTER shell is the user's login
  // shell, and zsh refuses job control when it is not interactive
  // ("can't change option: -m", exit 1, nothing runs). POSIX sh accepts it, so
  // the nesting confines the requirement to a shell that can meet it while the
  // user's own shell still interprets their command.
  //
  // The job learns exactly one thing about the world outside itself: how long
  // it may live. It knows nothing of sessions, injection, or its own record.

  // POSIX single-quoting: everything inside is literal, and an embedded quote
  // is closed, escaped, and reopened. The one form that survives a shell
  // without expanding anything.
  function quote(text: string) {
    return `'` + text.replaceAll(`'`, `'\\''`) + `'`
  }

  export function wrap(command: string, id: string, hardMs: number, shell = "/bin/sh") {
    const seconds = Math.max(1, Math.ceil(hardMs / 1000))
    // The TERM-to-KILL escalation window, shared with the outside killer so the
    // two agree: BackgroundProcess.kill waits longer than this before its own
    // SIGKILL, which is what stops it tearing this wrapper down mid-escalation.
    const escalate = BackgroundProcess.ESCALATION_SECONDS
    // The command is interpreted by the USER'S shell, launched from inside a
    // POSIX one. Both halves are required and neither shell can do the other's
    // job: zsh refuses job control when it is not interactive ("can't change
    // option: -m"), and running the command under plain `sh` would drop the
    // user's own login shell.
    const user = `${shell} -lc ${quote(command)}`
    // The watchdog lives INSIDE the nested shell, alongside the command.
    //
    // Only that shell knows the command's process group: job control assigns
    // the group there, and the launching shell sees just this shell's pid,
    // whose own group is its parent's. A watchdog placed outside would signal
    // that wrong group and never reach the command (verified: the command
    // outlived its deadline and ran to completion).
    const inner = [
      `set -m`,
      `{ ${user} ; } &`,
      `__oc_cmd=$!`,
      `set +m`,
      // A signal aimed at this wrapper is FORWARDED to the group the line above
      // created. An outside killer can only ever reach this process: it records
      // the identity it got from spawning, which is this shell, while `set -m`
      // puts the command in a group of its own that nothing out there can name.
      // Without the trap, killing the job kills the wrapper and its watchdog and
      // leaves the command running with nothing left that knows about it.
      //
      // The wrapper stays alive through the forward so it still reaches its exit
      // line below, which is what turns a kill into a recorded status rather
      // than a missing exit file.
      //
      // It escalates on its own rather than waiting for the killer's SIGKILL:
      // that second signal reaches this shell too, and a shell cannot trap it,
      // so a command ignoring TERM would be orphaned by the very escalation
      // meant to end it. Escalating here happens while the wrapper is still
      // alive to do it.
      `trap '{ kill -TERM -$__oc_cmd 2>/dev/null; sleep ${escalate}; kill -KILL -$__oc_cmd 2>/dev/null; } &' TERM INT HUP`,
      `{ sleep ${seconds}; kill -TERM -$__oc_cmd 2>/dev/null; sleep ${escalate}; kill -KILL -$__oc_cmd 2>/dev/null; } &`,
      `__oc_wd=$!`,
      // The command's own output already reached the log; these redirects
      // silence only the shell's reports ABOUT its jobs, which are noise to a
      // reader. The watchdog's death is announced too, since killing it is
      // what normally ends it.
      `wait $__oc_cmd 2>/dev/null`,
      `__oc_rc=$?`,
      `kill $__oc_wd 2>/dev/null`,
      `wait $__oc_wd 2>/dev/null`,
      `echo $__oc_rc > ${quote(exitPath(id))}`,
      `exit $__oc_rc`,
    ].join("\n")
    // Single-quoted, not JSON.stringify'd. Double quotes would let the OUTER
    // shell expand `$!` and `$?` before the inner shell ever ran, so every job
    // reported the outer shell's status and a failing command came back as
    // exit 0.
    return `sh -c ${quote(inner)}`
  }

  export async function write(info: Info) {
    await Storage.write([...PREFIX, info.id], info)
  }

  export async function get(id: string) {
    return Storage.read<Info>([...PREFIX, id]).catch(() => undefined)
  }

  export async function update(id: string, fn: (draft: Info) => void) {
    return Storage.update<Info>([...PREFIX, id], fn).catch(() => undefined)
  }

  export async function list() {
    const keys = await Storage.list(PREFIX)
    const jobs = await Promise.all(keys.map((key) => Storage.read<Info>(key).catch(() => undefined)))
    return jobs.filter((job): job is Info => job !== undefined)
  }

  export async function remove(id: string) {
    await Storage.remove([...PREFIX, id])
    await fs.unlink(logPath(id)).catch(() => {})
    await fs.unlink(exitPath(id)).catch(() => {})
  }

  // Stop a running job and settle its record.
  //
  // Three outcomes a caller must be able to tell apart, since each warrants a
  // different thing being said to whoever asked for the kill: no such job, a
  // job that cannot be signalled yet, and the record as it stands after the
  // attempt.
  //
  // A job whose pid no longer verifies is settled rather than signalled: it is
  // already gone, or the number belongs to something else now.
  export type Stopped = { type: "unknown" } | { type: "unspawned" } | { type: "settled"; job: Info }

  export async function stop(id: string): Promise<Stopped> {
    const job = await get(id)
    if (!job) return { type: "unknown" }
    if (job.status !== "running") return { type: "settled", job }
    // A record naming no process is one whose spawn has not returned yet: the
    // write happens first, deliberately, so a crash in that window leaves
    // something findable. Nothing can be signalled, and settling it anyway
    // would report a kill that did not happen AND take the record past
    // running, where no later pass reconciles it. The process that is about to
    // exist would then run to completion with a record calling it killed.
    if (!job.process) return { type: "unspawned" }
    // Claim BEFORE the kill, not after. The kill is what makes the process
    // exit, which resolves the live exit handle spawn.ts still holds; that
    // handle settles the record and delivers a result, waking the very session
    // being stopped. Killing first and claiming after loses that race every
    // time, because kill() sleeps through its TERM-to-KILL window while the
    // handle runs. Taking the record out of `running` first makes the handle's
    // settle find `status !== "running"` and return undefined, so onExit never
    // fires. Claimed inside the write lock, the same way a reconcile pass does,
    // so a stop racing a sweep cannot overwrite a verdict the sweep reached.
    let claimed = false
    const completed = Date.now()
    await update(id, (draft) => {
      if (draft.status !== "running") return
      claimed = true
      draft.status = "killed"
      draft.exit = undefined
      draft.time.completed = completed
    })
    const current = await get(id)
    // Removed between the read and the write, which only a concurrent cleanup
    // does; there is nothing left to describe.
    if (!current) return { type: "unknown" }
    // The claim lost: the job settled on its own in the same instant (its exit
    // handle or a sweep got there first). It is already gone, so there is
    // nothing to kill and its own recorded status stands.
    if (!claimed) return { type: "settled", job: current }
    await BackgroundProcess.kill(job.process)
    await settled(current.sessionID)
    return { type: "settled", job: current }
  }

  // Kill every running job a session owns. A job OUTLIVES the turn that
  // launched it, and a session accumulates them across turns, so stopping the
  // session is the point at which its still-running work must end too: the
  // record's `owner-gone` reap never fires for this in production (the liveness
  // predicate answers only `true`/`undefined`, never `false`), so a stopped
  // session's jobs would otherwise run to their hard deadline with nobody left
  // to read them. Signals each in parallel; each `stop` settles its own record.
  export async function stopSession(sessionID: string) {
    const running = await list().then((jobs) =>
      jobs.filter((job) => job.sessionID === sessionID && job.status === "running"),
    )
    await Promise.all(running.map((job) => stop(job.id)))
    return running.length
  }

  // The exit code the job recorded for itself. Undefined means it has not
  // finished, or it was killed before it could write.
  export async function exit(id: string) {
    const text = await Bun.file(exitPath(id))
      .text()
      .catch(() => "")
    const code = Number(text.trim())
    return text.trim() === "" || Number.isNaN(code) ? undefined : code
  }

  // When the job actually finished, read from the mtime of the exit file it
  // wrote as its last act. The live handle knows this instant directly (its
  // proc.exited resolves at it); a reconciling server that never held the
  // handle recovers it here, so both paths judge a timeout against the SAME
  // moment: when the job ended, not when a pass happened to notice. Undefined
  // when the file is absent (the job was SIGKILLed before writing it).
  export async function finishedAt(id: string) {
    return Bun.file(exitPath(id))
      .stat()
      .then((s) => s.mtimeMs)
      .catch(() => undefined)
  }

  // A job that ended AT OR PAST its hard deadline was stopped by its own
  // watchdog, not by finishing, so it reads `killed` (delivered as a timeout)
  // rather than `exited`. The one decision, shared by the live-handle settle and
  // the reconcile settle, so the two paths cannot label the same timeout
  // differently. `killed` only ever means "the deadline ended it": an unknown
  // finish instant cannot prove that, so it stays `exited`.
  export function settledStatus(hard: number, ended: number | undefined): Status {
    return ended !== undefined && ended >= hard ? "killed" : "exited"
  }

  export async function output(id: string) {
    return Bun.file(logPath(id))
      .text()
      .catch(() => "")
  }

  // What a reconciling server should do with this record, decided only from
  // the record, the filesystem, and the process table — never from in-memory
  // state, which a restart does not have.
  export type Verdict =
    | { type: "running"; identity: BackgroundProcess.Identity }
    | { type: "expired"; identity: BackgroundProcess.Identity }
    | { type: "finished"; exit: number | undefined }
    | { type: "orphaned" }

  export async function assess(job: Info, now = Date.now()): Promise<Verdict> {
    if (job.status !== "running") return { type: "finished", exit: job.exit }
    // A record whose spawn never landed (the server died in the window between
    // the write and the spawn) describes no process at all.
    if (!job.process) return { type: "orphaned" }

    const match = await BackgroundProcess.verify(job.process)
    // `mismatch` means the pid now belongs to something else, so the job is
    // unreachable rather than killable. Its output may still be complete.
    if (match !== "alive") return { type: "finished", exit: await exit(job.id) }
    if (now >= job.time.hard) return { type: "expired", identity: job.process }
    return { type: "running", identity: job.process }
  }

  // Reap results the owning session will never collect. Age is the primary
  // clock: a finished job's output is worth keeping while its session might
  // still be reopened, and worthless long after.
  export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

  // A COUNT bound as well, because age alone does not bound the directory. A
  // single heavy day writes thousands of jobs, all of them younger than the age
  // limit and none of them collectable, and every one leaves a log and an exit
  // file beside its record. Nothing reclaims them until they age out a week
  // later, so the directory grows unbounded across a busy stretch.
  export const MAX_RECORDS = 500

  export async function cleanup(now = Date.now()) {
    const jobs = await list()
    let removed = 0
    // Newest first, so the survivors of the count bound are the ones a reader
    // is most likely to come back for.
    const collectable = jobs
      .filter((job) => job.status !== "running" && !job.time.lost)
      .sort((a, b) => (b.time.completed ?? b.time.created) - (a.time.completed ?? a.time.created))
    for (const [index, job] of collectable.entries()) {
      // A result that never reached a session is the one nobody has had the
      // chance to come back for, and removing a record takes its log with it.
      // Ageing it out on the same clock as a delivered result would destroy
      // both the output and the stamp that says the output is worth reading.
      // Such records are filtered out above, so neither bound reaches them.
      const completed = job.time.completed ?? job.time.created
      if (now - completed < MAX_AGE_MS && index < MAX_RECORDS) continue
      await remove(job.id)
      removed++
    }
    if (removed > 0) log.info("cleaned up job results", { removed })
    return removed
  }
}
