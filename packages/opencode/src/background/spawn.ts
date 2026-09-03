import fs from "fs/promises"
import { Log } from "@/util/log"
import { SessionRecent } from "@/session/recent"
import { BackgroundJob } from "./job"
import { BackgroundProcess } from "./process"

// Launching a shell job so that nothing about it depends on this server
// staying alive.
export namespace BackgroundSpawn {
  const log = Log.create({ service: "background-spawn" })

  // How long a call waits before handing back a task id. A CEILING, not a
  // wait: the race resolves the moment the process exits, so an `ls` returns
  // in milliseconds and never sees the timer. Long enough that ordinary
  // read-decide-act commands stay inline and sequential reasoning survives;
  // short enough that a slow command cannot stall a turn.
  export const GRACE_MS = 5_000

  export const HARD_MS = 30 * 60 * 1000

  export type Input = {
    command: string
    description: string
    sessionID: string
    directory: string
    // The project the session belongs to, which `directory` does not name when
    // the caller passed a workdir outside it.
    project: string
    shell: string
    env: Record<string, string | undefined>
    hard?: number
    soft?: number
  }

  export type Result =
    | { type: "inline"; job: BackgroundJob.Info; output: string; exit: number }
    | { type: "background"; job: BackgroundJob.Info }

  // Called the moment a backgrounded job exits under a server that stayed up.
  // The reconcile pass calls the same thing for a job that finished while the
  // server was down, so a result looks identical either way.
  export type OnExit = (job: BackgroundJob.Info) => void | Promise<void>

  let onExit: OnExit | undefined
  export function watch(handler: OnExit) {
    onExit = handler
  }

  export async function run(input: Input): Promise<Result> {
    await BackgroundJob.init()
    const id = BackgroundJob.id()
    const created = Date.now()
    const hard = input.hard ?? HARD_MS

    // WRITE BEFORE SPAWN. A crash between the write and the spawn leaves a
    // record naming no process, which the reconciler reads as orphaned and
    // discards. The reverse order leaves a live process no record names,
    // which nothing can ever find. Only one of those is recoverable.
    const job: BackgroundJob.Info = {
      id,
      sessionID: input.sessionID,
      directory: input.directory,
      project: input.project,
      command: input.command,
      description: input.description,
      status: "running",
      time: {
        created,
        hard: created + hard,
        ...(input.soft ? { soft: created + input.soft } : {}),
      },
    }
    await BackgroundJob.write(job)
    // Flagged at the START, not at the next sweep. The sweep runs every five
    // minutes, so deriving the flag there alone leaves a session looking idle
    // for most of a short job's life and for the whole of one that begins and
    // ends between two passes. The sweep still derives it from disk, which is
    // what corrects a flag this process never got to clear.
    void SessionRecent.setBusyJob(input.sessionID, true)

    // Output goes to a FILE, never a pipe. A pipe dies with the process
    // holding it, so a server restart would sever a surviving job from its
    // own output; a file is still being appended to when a replacement
    // server opens it.
    const handle = await fs.open(BackgroundJob.logPath(id), "a")
    const proc = Bun.spawn({
      // Launched under POSIX sh, which the wrapper needs for job control. The
      // user's own login shell runs one level in and interprets the command.
      cmd: ["/bin/sh", "-c", BackgroundJob.wrap(input.command, id, hard, input.shell)],
      cwd: input.directory,
      env: input.env as Record<string, string>,
      // stdin closed, not inherited: an interactive command then fails
      // immediately with a clear error instead of blocking forever on input
      // that can never arrive. That failure is the signal to use a terminal.
      stdio: ["ignore", handle.fd, handle.fd],
      // setsid, so the job leads its own group and outlives this server. The
      // group is also what a later kill signals to take the whole subtree.
      detached: true,
    })
    // Nothing in this process waits on the job, so it must not hold the
    // event loop open either.
    proc.unref()

    const identity = await BackgroundProcess.inspect(proc.pid)
    await BackgroundJob.update(id, (draft) => {
      draft.process = identity ? { pid: identity.pid, start: identity.start, pgid: identity.pgid } : undefined
    })

    // The race. Whichever settles first decides the shape of the result; the
    // job is identical either way, and so is everything on disk.
    const finished = await Promise.race([proc.exited.then(() => true), Bun.sleep(GRACE_MS).then(() => false)])

    if (!finished) {
      log.info("job passed the grace window", { id, command: input.description })
      // The handle is still live in THIS process, so its exit needs no polling
      // and no worker: awaiting the promise we already hold is what makes a
      // result arrive the instant the job ends rather than at the next
      // reconcile pass, which could be half an hour later. That pass remains
      // the recovery path for a job whose handle died with its server.
      void proc.exited.then(async () => {
        await handle.close().catch(() => {})
        const settled = await settle(id)
        if (settled && onExit) await onExit(settled)
      })
      return { type: "background", job: (await BackgroundJob.get(id)) ?? job }
    }

    await handle.close()
    const settled = await settle(id)
    return {
      type: "inline",
      job: settled ?? job,
      output: await BackgroundJob.output(id),
      exit: settled?.exit ?? proc.exitCode ?? 0,
    }
  }

  // Move a record from running to finished, reading the exit code the job wrote
  // for itself. Shared by the inline return and the exit watcher so both leave
  // the record in the same shape.
  //
  // Returns the record ONLY to the caller that made the transition. Settling is
  // what earns the right to deliver, so the guarded write and the answer have to
  // agree: returning the record regardless lets a caller that lost the race
  // deliver a result someone else already delivered. The exit watcher and a
  // reconcile sweep are woken by the same event — the job ending — so both reach
  // here for one job as a matter of course, not as a rare race.
  async function settle(id: string) {
    const exit = await BackgroundJob.exit(id)
    const completed = Date.now()
    let claimed = false
    await BackgroundJob.update(id, (draft) => {
      if (draft.status !== "running") return
      claimed = true
      // A job that reached its own hard deadline was ended by its watchdog, not
      // by finishing. It exits on the watchdog's TERM/KILL (rc 143/137), which
      // is indistinguishable from a failure by exit code alone, so the deadline
      // is what tells the two apart. Recording `killed` here is the same verdict
      // the reconcile backstop reaches for a job it has to kill itself, so both
      // timeout paths deliver `timeout` rather than one showing up as `failed`.
      draft.status = completed >= draft.time.hard ? "killed" : "exited"
      draft.exit = exit
      draft.time.completed = completed
    })
    if (!claimed) return undefined
    const settled = await BackgroundJob.get(id)
    // Only the caller that made the transition clears the flag.
    if (settled) await BackgroundJob.settled(settled.sessionID)
    return settled
  }
}
