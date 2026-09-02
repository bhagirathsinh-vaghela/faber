import fs from "fs/promises"
import { Log } from "@/util/log"
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
    shell: string
    env: Record<string, string | undefined>
    hard?: number
    soft?: number
  }

  export type Result =
    | { type: "inline"; job: BackgroundJob.Info; output: string; exit: number }
    | { type: "background"; job: BackgroundJob.Info }

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

    // Output goes to a FILE, never a pipe. A pipe dies with the process
    // holding it, so a server restart would sever a surviving job from its
    // own output; a file is still being appended to when a replacement
    // server opens it.
    const handle = await fs.open(BackgroundJob.logPath(id), "a")
    const proc = Bun.spawn({
      cmd: [input.shell, "-lc", BackgroundJob.wrap(input.command, id, hard)],
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
    const finished = await Promise.race([
      proc.exited.then(() => true),
      Bun.sleep(GRACE_MS).then(() => false),
    ])

    if (!finished) {
      log.info("job passed the grace window", { id, command: input.description })
      return { type: "background", job: (await BackgroundJob.get(id)) ?? job }
    }

    await handle.close()
    const exit = (await BackgroundJob.exit(id)) ?? proc.exitCode ?? 0
    const output = await BackgroundJob.output(id)
    const completed = Date.now()
    await BackgroundJob.update(id, (draft) => {
      draft.status = "exited"
      draft.exit = exit
      draft.time.completed = completed
    })

    return { type: "inline", job: (await BackgroundJob.get(id))!, output, exit }
  }
}
