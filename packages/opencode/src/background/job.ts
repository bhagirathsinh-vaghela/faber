import path from "path"
import fs from "fs/promises"
import z from "zod"
import { Global } from "@/global"
import { Log } from "@/util/log"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { Db } from "@/storage/db"
import { BackgroundProcess } from "./process"
import { Debt } from "@/storage/debt"
import { Jobs } from "@/storage/jobs"

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

  // What the PROCESS did. Whether its session has been told is a separate
  // question, answered by its debt (storage/debt.ts).
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
      // The server process that launched the job and holds its exit handle,
      // by pid and start time. While it is alive it settles the job itself, so
      // another server's pass leaves the record alone.
      launcher: z.object({ pid: z.number(), boot: z.number() }).optional(),
      time: z.object({
        created: z.number(),
        // Deadlines, NOT timers. A setTimeout dies with the process that set
        // it, so a bound expressed as a timer silently lapses across a
        // restart. An absolute instant on disk is still true when a
        // replacement server reads it an hour later.
        soft: z.number().optional(),
        hard: z.number(),
        completed: z.number().optional(),
        // The progress nudge past the soft deadline repeats, so it needs two
        // facts a single stamp cannot hold: how many have gone out (the ordinal
        // the prose keys on for first-vs-repeat) and when the last one did (the
        // cadence). A record carrying neither has been nudged zero times, which
        // is the correct start for a job that predates these fields as much as
        // for a fresh one.
        nudges: z.number().optional(),
        nudgedAt: z.number().optional(),
      }),
      exit: z.number().optional(),
      // Why a job that did not finish on its own ended: a Stop of its session,
      // a kill (the model's own, or an Esc cancelling its launch), or the
      // deadline. Absent for a job that ran to its exit.
      ended: z.enum(["stop", "kill", "timeout"]).optional(),
    })
    .meta({ ref: "BackgroundJob" })
  export type Info = z.infer<typeof Info>

  // A job crossed a lifecycle boundary: it was just spawned, or it settled
  // (exited/killed). The whole record rides the event, so a real-time consumer
  // (the jobs view) applies it without a refetch, and its `status` field is
  // what tells created from settled — one event type keeps the client
  // subscription to a single handler.
  //
  // A SIGNAL, never a source of truth. The record on disk is the truth; this
  // only says "look again". A consumer that missed one (it connected late, a
  // frame dropped) is corrected by the sweep's periodic re-derivation, the same
  // backstop every other job signal leans on.
  export const Event = {
    Updated: BusEvent.define("job.updated", z.object({ job: Info })),
  }

  // Emitted straight onto the GlobalBus rather than through Bus.publish, which
  // resolves its subscriber list from an instance context. Every path that
  // settles a job can run without one — the boot sweep, a Scheduler tick, the
  // exit watcher's floating promise — so an instance-scoped publish would throw
  // "No context found for instance" exactly where a job most needs to announce
  // itself. The event is globally scoped anyway (one machine's jobs, no project
  // axis), so it is tagged "global" the way SessionRecent tags its own.
  export function publish(job: Info) {
    GlobalBus.emit("event", {
      directory: "global",
      payload: { type: Event.Updated.type, properties: { job } },
    })
  }

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
  // The command is put in a process group of its own, which is what lets the
  // watchdog signal `-$__oc_cmd` and take the whole subtree. Without it the
  // command shares the wrapper's group, so the watchdog reaches only the direct
  // child and a `make`'s compilers keep running.
  //
  // Two mechanisms reach that same end, one per platform, because neither works
  // on the other. `setsid` (Linux, absent on macOS) execs the command as a new
  // session leader, so its pid IS its group. `set -m` (macOS) turns on job
  // control, which puts a backgrounded command in its own group; POSIX sh
  // accepts it non-interactively, but dash then refuses on a machine with no
  // controlling tty ("can't access tty; job control turned off") and leaves the
  // command in the wrapper's group. Either way `$!` ends up equal to the
  // command's group id, so every `kill -$__oc_cmd` below is unchanged.
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
    // The watchdog lives INSIDE this shell, alongside the command, because only
    // here is the command's group id known: `$!` after the launch below equals
    // it on both platforms. A watchdog placed outside would see just this
    // shell's pid, whose group is its parent's, and signal the wrong group
    // (verified: the command outlived its deadline and ran to completion).
    const inner = [
      // Prefer setsid (Linux) so no tty is needed; fall back to set -m (macOS,
      // which has no setsid). `set +m` after is harmless when -m never ran.
      `if command -v setsid >/dev/null 2>&1; then`,
      `  setsid ${user} &`,
      `else`,
      `  set -m 2>/dev/null`,
      `  { ${user} ; } &`,
      `fi`,
      `__oc_cmd=$!`,
      `set +m 2>/dev/null`,
      // A signal aimed at this wrapper is FORWARDED to the command's group. An
      // outside killer can only ever reach this process: it records the identity
      // it got from spawning, which is this shell, while the launch above puts
      // the command in a group of its own that nothing out there can name.
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
      // Killing a subshell does not kill the `sleep` it is waiting on, which
      // would linger for the whole deadline, so the watchdog sleeps in the
      // background and its TERM trap takes that sleep down with it.
      `{ trap 'kill $__oc_s 2>/dev/null; exit 0' TERM; sleep ${seconds} & __oc_s=$!; wait $__oc_s; kill -TERM -$__oc_cmd 2>/dev/null; sleep ${escalate} & __oc_s=$!; wait $__oc_s; kill -KILL -$__oc_cmd 2>/dev/null; } &`,
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

  export const write = Jobs.put
  export const get = Jobs.get
  export const list = Jobs.list

  // A launch's record and the debt it owes its session, in one transaction: a
  // job is never owed without a record, nor recorded without being owed.
  export async function create(job: Info) {
    const [put, debts] = await Promise.all([Jobs.writer(), Debt.claimer()])
    await Db.transaction(() => {
      debts.owe(job.id, "job", job.sessionID, job.time.created)
      put(job)
    })
  }

  // `fn` returns false for a no-op, which leaves the row unwritten.
  export async function update(id: string, fn: (draft: Info) => boolean | void) {
    return Jobs.update(id, fn)
  }

  export async function remove(id: string) {
    await Jobs.remove(id)
    await fs.unlink(logPath(id)).catch(() => {})
    await fs.unlink(exitPath(id)).catch(() => {})
  }

  // Stop a running job and settle its record.
  //
  // A caller must be able to tell the outcomes apart, since each warrants a
  // different thing being said to whoever asked for the kill: no such job, a
  // job that cannot be signalled yet, and the record as it stands after the
  // attempt. `killed` is whether THIS call ended it, as opposed to finding it
  // already settled.
  //
  // A job whose pid no longer verifies is settled as it really ended rather
  // than signalled: it is already gone, or the number belongs to something
  // else now. That is never recorded as a kill, and its debt stays for
  // Recovery to deliver the real result.
  // `why` is recorded on the job so the outcome its caller is told names the
  // real cause. `pay` takes the job's debt in the same write that claims it,
  // for a kill whose own reply is the payment.
  export type Stopped = { type: "unknown" } | { type: "unspawned" } | { type: "settled"; job: Info; killed: boolean }

  // How close to the claim an exit file's time may be and still count as the
  // kill's own doing: the filesystem clock can trail Date.now() by a few
  // milliseconds.
  const GRACE_MS = 50

  export async function stop(id: string, options: { why?: "stop" | "kill"; pay?: boolean } = {}): Promise<Stopped> {
    const job = await get(id)
    if (!job) return { type: "unknown" }
    if (job.status !== "running") return { type: "settled", job, killed: false }
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
    // fires. The claim and the debt payment commit together, so no pass can
    // deliver this job's result between them.
    const claim = await Jobs.mutator()
    const alive = (await BackgroundProcess.verify(job.process)) === "alive"
    const code = alive ? undefined : await exit(id)
    const finished = alive ? undefined : await finishedAt(id)
    const debts = await Debt.claimer()
    const completed = Date.now()
    const claimed = await Db.transaction(() => {
      const draft = claim(id, (draft) => {
        if (draft.status !== "running") return false
        draft.time.completed = finished ?? completed
        if (!alive) {
          draft.status = settledStatus(draft.time.hard, finished)
          if (draft.status === "killed") draft.ended = "timeout"
          draft.exit = code
          return true
        }
        draft.status = "killed"
        draft.ended = options.why ?? "stop"
        draft.exit = undefined
        return true
      })
      if (draft && alive && options.pay) debts.pay(id)
      return !!draft
    })
    const current = await get(id)
    // Removed between the read and the write, which only a concurrent cleanup
    // does; there is nothing left to describe.
    if (!current) return { type: "unknown" }
    // The claim lost: the job settled on its own in the same instant (its exit
    // handle or a sweep got there first). It is already gone, so there is
    // nothing to kill and its own recorded status stands.
    if (!claimed) return { type: "settled", job: current, killed: false }
    if (!alive) {
      publish(current)
      return { type: "settled", job: current, killed: false }
    }
    // The paid debt leaves busy before the kill, which sleeps through its
    // TERM-to-KILL window.
    if (options.pay) {
      const { SessionBusy } = await import("@/session/busy")
      await SessionBusy.push(current.sessionID)
    }
    await BackgroundProcess.kill(job.process)
    // The liveness check and the claim are not one step: a job can write its
    // exit file after the check found it alive and before the claim took it.
    // An exit file older than the claim is that job, which ended on its own;
    // its record says so, and its debt stays for Recovery to deliver. One
    // within GRACE_MS of the claim is the kill's own doing (the wrapper writes
    // it on the TERM).
    const own = await finishedAt(id)
    const real = await exit(id)
    const corrected =
      own === undefined || own >= completed - GRACE_MS
        ? undefined
        : await Db.transaction(() => {
            const draft = claim(id, (draft) => {
              if (draft.status !== "killed" || draft.time.completed !== completed) return false
              draft.status = settledStatus(draft.time.hard, own)
              draft.ended = draft.status === "killed" ? "timeout" : undefined
              draft.exit = real
              draft.time.completed = own
              return true
            })
            if (draft && options.pay) debts.owe(id, "job", draft.sessionID, draft.time.created)
            return draft
          })
    if (!corrected) {
      publish(current)
      return { type: "settled", job: current, killed: true }
    }
    if (options.pay) {
      const { SessionBusy } = await import("@/session/busy")
      await SessionBusy.push(corrected.sessionID)
    }
    publish(corrected)
    return { type: "settled", job: corrected, killed: false }
  }

  // The kind of result a settled job tells its caller, from how it ended.
  export function outcome(job: Info) {
    if (job.status !== "killed") return "completed" as const
    if (job.ended === "stop") return "stopped" as const
    if (job.ended === "kill") return "killed" as const
    return "timeout" as const
  }

  // Kill every running job a session owns. A job OUTLIVES the turn that
  // launched it, and a session accumulates them across turns, so stopping the
  // session is the point at which its still-running work must end too; nothing
  // else ends a job before its hard deadline. Signals each in parallel; each
  // `stop` settles its own record. Delivers nothing: its caller,
  // `Session.stop`, pays every job debt afterwards via `Recovery.stopped`.
  export async function stopSession(sessionID: string) {
    const running = await list().then((jobs) =>
      jobs.filter((job) => job.sessionID === sessionID && job.status === "running"),
    )
    await Promise.all(running.map((job) => stop(job.id, { why: "stop" })))
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

  // When the job actually finished, recovered from the mtime of the exit file it
  // wrote as its last act. A reconciling server that never held the job's handle
  // has no other record of when it ended, so this is what lets it judge a
  // timeout against the job's own finish instant rather than against whenever a
  // pass happened to notice. Undefined when the file is absent (the job was
  // SIGKILLed before writing it).
  export async function finishedAt(id: string) {
    return Bun.file(exitPath(id))
      .stat()
      .then((s) => s.mtimeMs)
      .catch(() => undefined)
  }

  // How fresh a running job's output is: the log's mtime advances on every
  // write, so a stale one is a job that has gone silent. Undefined when the log
  // is absent (a spawn that never landed).
  export async function logMtime(id: string) {
    return Bun.file(logPath(id))
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

  // How often a job past its soft deadline is nudged. No count cap: a job cannot
  // outlive its hard deadline (the watchdog kills it, and a killed job is never
  // nudged — the status guard below stops it), so the deadline is the bound, and
  // a separate cap would wrongly silence a job whose deadline was raised. The
  // cadence is loose and the delta each nudge carries (elapsed, log freshness) is
  // what keeps a repeat worth reading rather than nudge-blindness.
  export const NUDGE_MS = 3 * 60 * 1000

  // A won nudge claim, carrying the stamps it replaced so a check-in that never
  // landed can hand them back through `retract`.
  export type Nudge = { ordinal: number; previous: { nudges?: number; nudgedAt?: number } }

  // Whether a running job is due another nudge, claimed and stamped atomically
  // so two passes cannot both send one. Returns the claim, whose ordinal is 1
  // for the first, when this caller won it, undefined otherwise — the ordinal is
  // what the prose keys on to say the first nudge's fuller contract once and the
  // tighter repeat after.
  //
  // Due when the job is past its soft deadline: the FIRST nudge fires as soon as
  // the deadline is behind it — the deadline is itself the "should have finished
  // by now" mark — while every later one waits NUDGE_MS since the previous
  // nudge. Keying the first on the deadline rather than on NUDGE_MS-past-it is
  // what makes the soft deadline mean what the caller set it to. A killed or
  // exited job is never due: the status guard is what bounds the total against
  // the hard deadline.
  //
  // The claim runs inside the write lock, the same shape as a settle claim, so
  // the read and the stamp cannot interleave with another pass.
  export async function nudge(id: string, now = Date.now()): Promise<Nudge | undefined> {
    let claimed: Nudge | undefined
    await update(id, (draft) => {
      if (draft.status !== "running" || draft.time.soft === undefined) return false
      const due = draft.time.nudgedAt === undefined ? draft.time.soft : draft.time.nudgedAt + NUDGE_MS
      if (now < due) return false
      claimed = {
        ordinal: (draft.time.nudges ?? 0) + 1,
        previous: { nudges: draft.time.nudges, nudgedAt: draft.time.nudgedAt },
      }
      draft.time.nudges = claimed.ordinal
      draft.time.nudgedAt = now
    })
    return claimed
  }

  // Undo a nudge whose check-in was not delivered, so the ordinal it claimed is
  // the next one sent. Only while the record still holds that ordinal: a later
  // claim has already moved past it.
  export async function retract(id: string, claimed: Nudge) {
    await update(id, (draft) => {
      if (draft.time.nudges !== claimed.ordinal) return false
      draft.time.nudges = claimed.previous.nudges
      draft.time.nudgedAt = claimed.previous.nudgedAt
    })
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
    // A job still owed to its session is kept until that session is deleted:
    // removing the record takes its output with it, and the debt would then
    // pay nothing.
    const owed = new Set((await Debt.list()).map((debt) => debt.responder))
    let removed = 0
    // Newest first, so the survivors of the count bound are the ones a reader
    // is most likely to come back for.
    const collectable = jobs
      .filter((job) => job.status !== "running" && !owed.has(job.id))
      .sort((a, b) => (b.time.completed ?? b.time.created) - (a.time.completed ?? a.time.created))
    for (const [index, job] of collectable.entries()) {
      const completed = job.time.completed ?? job.time.created
      if (now - completed < MAX_AGE_MS && index < MAX_RECORDS) continue
      await remove(job.id)
      removed++
    }
    if (removed > 0) log.info("cleaned up job results", { removed })
    return removed
  }
}
