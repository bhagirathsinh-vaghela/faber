import fs from "fs/promises"
import { Log } from "@/util/log"
import { SessionBusy } from "@/session/busy"
import { BackgroundJob } from "./job"
import { BackgroundProcess } from "./process"
import { Debt } from "@/storage/debt"
import { Db } from "@/storage/db"

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

  // Ceiling on the first progress check-in, so a nudge always arrives by this
  // point however large or absent the caller's estimate. A caller may pass a
  // `soft` estimate of the command's runtime, which can only pull the first
  // check-in EARLIER (it is min'd with this) and never later, so a wrong
  // estimate is cheap: too high is clamped here, too low costs one early nudge.
  // With no estimate the check-in falls to half the hard budget, keeping a
  // short-hard job nudged before its kill rather than after it.
  export const SOFT_CAP_MS = 3 * 60 * 1000

  export type Input = {
    command: string
    description: string
    sessionID: string
    // The launching turn's abort. Once a stop or Esc cancels that turn, its
    // marker can be cleared or replaced before this launch is reached, so the
    // marker alone cannot tell that the turn was stopped.
    signal?: AbortSignal
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
  // Returns the handler it replaced, so a caller swapping one in can restore it.
  export function watch(handler: OnExit | undefined) {
    const previous = onExit
    onExit = handler
    return previous
  }

  // Jobs this process is launching, or holds a live exit handle for. The handle
  // settles them, so a reconcile pass must not: it would reap a record whose
  // identity is not written yet, or settle an inline job whose result is going
  // back as tool output and pay it a second time. Another process's pass is
  // kept off by the record's `launcher`, which names this process while it
  // lives; this set is this process's own, which the launcher alone cannot
  // tell apart from a handle already let go.
  const held = new Set<string>()
  export function holding(id: string) {
    return held.has(id)
  }

  export async function run(input: Input): Promise<Result> {
    await BackgroundJob.init()
    const id = BackgroundJob.id()
    held.add(id)
    return launch(input, id).then(
      (result) => {
        if (result.type === "inline") held.delete(id)
        return result
      },
      (error) => {
        held.delete(id)
        throw error
      },
    )
  }

  async function launch(input: Input, id: string): Promise<Result> {
    const created = Date.now()
    const hard = input.hard ?? HARD_MS
    const soft = Math.min(input.soft ?? hard / 2, SOFT_CAP_MS)

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
      launcher: { pid: process.pid, boot: BackgroundProcess.boot },
      time: {
        created,
        hard: created + hard,
        soft: created + soft,
      },
    }
    // A launch that never produced a process leaves nothing to wait for: its
    // record and its debt go, so the session is not held open by a ghost.
    const abandon = async (error: unknown) => {
      await Debt.remove(id).catch((failure) => log.error("could not drop an abandoned job's debt", { id, failure }))
      await BackgroundJob.remove(id).catch((failure) => log.error("could not remove an abandoned job", { id, failure }))
      await SessionBusy.push(input.sessionID)
      throw error
    }
    await BackgroundJob.create(job)
    // A stop racing this launch can miss it: stopSession finds no process to
    // kill. So the launch checks its turn's signal for itself.
    const stopped = () => !!input.signal?.aborted
    const refused = () => new Error(`session ${input.sessionID} was stopped while launching job ${id}`)
    // A Stop aborts with its own reason; any other cancel (an Esc, a turn
    // abort) ends the launch as a kill, and wakes the session with the result.
    const halt = async () => {
      const { SessionPrompt } = await import("@/session/prompt")
      return input.signal?.reason === SessionPrompt.STOPPED
    }
    await SessionBusy.push(input.sessionID)
    if (stopped()) await abandon(refused())

    // Output goes to a FILE, never a pipe. A pipe dies with the process
    // holding it, so a server restart would sever a surviving job from its
    // own output; a file is still being appended to when a replacement
    // server opens it.
    const handle = await fs.open(BackgroundJob.logPath(id), "a").catch(abandon)
    const proc = await Promise.resolve()
      .then(() =>
        Bun.spawn({
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
        }),
      )
      .catch(async (error) => {
        await handle.close().catch(() => {})
        return abandon(error)
      })
    // Nothing in this process waits on the job, so it must not hold the
    // event loop open either.
    proc.unref()

    // A live job whose identity cannot be read is one nothing could ever find:
    // the sweep discards a record with no identity as an orphan, silently
    // losing the result, and a stop cannot signal it. So a failed read gets a
    // second look, and a job still unreadable is ended through the handle
    // (Bun has not reaped it, so the pid is still this job's group leader).
    // An empty read is first given a moment to show up as an exit, since a
    // quick command is often gone before `ps` looks.
    const exited = () => Promise.race([proc.exited.then(() => true), Bun.sleep(250).then(() => false)])
    const identity =
      (await BackgroundProcess.inspect(proc.pid)) ??
      ((await exited()) ? undefined : await BackgroundProcess.inspect(proc.pid))
    if (!identity && !(await exited())) {
      await Promise.resolve()
        .then(() => process.kill(-proc.pid, "SIGTERM"))
        .catch(() => {})
      await handle.close().catch(() => {})
      // The wrapper's trap writes its exit file while it unwinds, after the
      // abandon below has unlinked it, and nothing else would ever remove it.
      void proc.exited.then(() => fs.unlink(BackgroundJob.exitPath(id)).catch(() => {}))
      await abandon(new Error(`could not read the identity of job ${id} (pid ${proc.pid}); it was killed`))
    }
    await BackgroundJob.update(id, (draft) => {
      draft.process = identity ? { pid: identity.pid, start: identity.start, pgid: identity.pgid } : undefined
    })
    // A stop between the check above and this write found the record with no
    // process and killed nothing; its abort is visible now, so the kill
    // happens here. A later stop finds the process itself. An Esc landing
    // between the first check and here (the log open, the spawn, and the
    // identity reads) kills a job an Esc a moment later would leave running;
    // the launch belongs to the turn being cancelled.
    if (stopped()) {
      const stop = await halt()
      const ended = await BackgroundJob.stop(id, { why: stop ? "stop" : "kill" })
      await handle.close().catch(() => {})
      // Unspawned means the record has no identity, which past the check
      // above means the process already exited: the record and debt go now.
      if (ended.type === "unspawned") await abandon(refused())
      // The stop claimed without paying, and no exit handle is held for this
      // job, so its result is paid here.
      if (ended.type === "settled") {
        const { Recovery } = await import("@/session/recovery")
        await Recovery.collect(input.sessionID, { fresh: true, wake: !stop })
      }
      throw refused()
    }

    // Announce the running job once its process identity is on the record, so a
    // view that applies the event has the same shape the sweep would later
    // re-derive. Emitted for every call, inline or backgrounded: a job that
    // finishes inside the grace window still existed, and a view that saw it
    // start and finish is correct where one that only ever saw finished rows is
    // missing the ones that were quick.
    BackgroundJob.publish((await BackgroundJob.get(id)) ?? job)

    // The race. Whichever settles first decides the shape of the result; the
    // job is identical either way, and so is everything on disk.
    const finished = await Promise.race([proc.exited.then(() => true), Bun.sleep(GRACE_MS).then(() => false)])

    if (!finished) {
      log.info("job passed the grace window", { id, command: input.description })
      // The handle is still live in THIS process, so its exit needs no polling
      // and no worker: awaiting the promise we already hold is what makes a
      // result arrive the instant the job ends rather than at the next
      // reconcile sweep, up to five minutes later. That pass remains
      // the recovery path for a job whose handle died with its server.
      void proc.exited
        .then(async () => {
          await handle.close().catch(() => {})
          const settled = await settle(id)
          if (settled && onExit) await onExit(settled)
        })
        .catch((error) => log.error("could not settle a finished job", { id, error }))
        .finally(() => held.delete(id))
      return { type: "background", job: (await BackgroundJob.get(id)) ?? job }
    }

    // The result goes back inline as the tool's output, which pays its debt.
    // Paid before settling: a settled job with a debt is what recovery pays.
    // Kept when the turn's signal was cancelled, since nothing reads that
    // output: the collector delivers it instead. A cancel landing after the
    // payment puts the debt back once the job is settled, for the same reason,
    // unless the cancel is a Stop: its abort precedes its payment, so a debt
    // put back after it would outlive the Stop that paid everything.
    const early = stopped()
    if (!early) await Debt.remove(id).then(() => SessionBusy.push(input.sessionID))
    await handle.close().catch(() => {})
    const settled = await settle(id)
    const [{ SessionPrompt }, { Recovery }] = await Promise.all([
      import("@/session/prompt"),
      import("@/session/recovery"),
    ])
    const debts = await Debt.claimer()
    // A Stop in flight holds the session before it cancels, so an Esc that
    // aborted first (its reason stays) is still seen as stopping here. A job
    // someone else settled (a concurrent kill) is theirs to report, so its debt
    // is not put back.
    const late =
      !early &&
      settled !== undefined &&
      (await Db.transaction(() => {
        if (!stopped() || input.signal?.reason === SessionPrompt.STOPPED || Recovery.held(input.sessionID)) return false
        debts.owe(id, "job", input.sessionID, created)
        return true
      }))
    if (late) await SessionBusy.push(input.sessionID)
    const kept = early || late
    if (kept && settled && onExit)
      void Promise.resolve(onExit(settled)).catch((error) =>
        log.error("could not announce a kept result", { id, error }),
      )
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
    const settled = await BackgroundJob.update(id, (draft) => {
      if (draft.status !== "running") return false
      // `completed` is taken just after the exit is observed, so
      // it is the moment settledStatus judges the deadline against. A job ended
      // by its own watchdog reads `killed` and is delivered as a timeout.
      draft.status = BackgroundJob.settledStatus(draft.time.hard, completed)
      if (draft.status === "killed") draft.ended = "timeout"
      draft.exit = exit
      draft.time.completed = completed
    })
    // Only the caller that made the transition announces the record it wrote,
    // so the view learns a job ended exactly once.
    if (settled) BackgroundJob.publish(settled)
    return settled
  }
}
