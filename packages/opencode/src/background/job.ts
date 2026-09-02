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

  export const Status = z.enum(["running", "exited", "killed", "lost"])
  export type Status = z.infer<typeof Status>

  export const Info = z
    .object({
      id: z.string(),
      sessionID: z.string(),
      directory: z.string(),
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
  // `set -m` is load-bearing. Job control puts each background job in a
  // process group of its own, which is what lets the watchdog signal
  // `-$__oc_cmd` and take the command's whole subtree. Without it the command
  // shares the wrapper's group, so the watchdog can only signal the direct
  // child and a `make`'s compilers keep running (verified: a backgrounded
  // grandchild survives the kill).
  //
  // The job learns exactly one thing about the world outside itself: how long
  // it may live. It knows nothing of sessions, injection, or its own record.
  export function wrap(command: string, id: string, hardMs: number) {
    const seconds = Math.max(1, Math.ceil(hardMs / 1000))
    const exit = exitPath(id)
    return [
      `set -m`,
      `{ ${command} ; } &`,
      `__oc_cmd=$!`,
      `{ sleep ${seconds}; kill -TERM -$__oc_cmd 2>/dev/null; sleep 2; kill -KILL -$__oc_cmd 2>/dev/null; } &`,
      `__oc_wd=$!`,
      `wait $__oc_cmd`,
      `__oc_rc=$?`,
      `kill $__oc_wd 2>/dev/null`,
      `echo $__oc_rc > ${JSON.stringify(exit)}`,
      `exit $__oc_rc`,
    ].join("\n")
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

  // The exit code the job recorded for itself. Undefined means it has not
  // finished, or it was killed before it could write.
  export async function exit(id: string) {
    const text = await Bun.file(exitPath(id))
      .text()
      .catch(() => "")
    const code = Number(text.trim())
    return text.trim() === "" || Number.isNaN(code) ? undefined : code
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

  // Reap results the owning session will never collect. Age-based rather than
  // count-based: a finished job's output is worth keeping while its session
  // might still be reopened, and worthless long after.
  export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

  export async function cleanup(now = Date.now()) {
    const jobs = await list()
    let removed = 0
    for (const job of jobs) {
      if (job.status === "running") continue
      const completed = job.time.completed ?? job.time.created
      if (now - completed < MAX_AGE_MS) continue
      await remove(job.id)
      removed++
    }
    if (removed > 0) log.info("cleaned up job results", { removed })
    return removed
  }
}
