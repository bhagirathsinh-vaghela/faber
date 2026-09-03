import { Log } from "@/util/log"

// Identifying and signalling a process the CURRENT process may not have spawned.
//
// A background job outlives the server that launched it (it is spawned detached,
// so a restart reparents it to init rather than killing it). The replacement
// server therefore has only a stored record to work from, and must be able to
// prove that record still names the same process before acting on it.
export namespace BackgroundProcess {
  const log = Log.create({ service: "background-process" })

  // How long the wrapper's own trap takes to escalate SIGTERM to SIGKILL on the
  // command's group. The command runs under `set -m` in a group of its own that
  // nothing outside can name, so `kill` below can only signal the WRAPPER's
  // group. A command that ignores SIGTERM is ended by the wrapper's trap, which
  // forwards TERM to the inner group, waits this long, then KILLs it.
  //
  // Exported because `BackgroundJob.wrap` builds the trap from the same number:
  // one source for the two halves of one escalation. The outer `kill` delay is
  // derived from it so the outside killer waits for the trap rather than racing
  // it.
  export const ESCALATION_SECONDS = 2

  // The outer wait before `kill` sends its own SIGKILL, set to exceed the
  // wrapper's escalation window. That ordering makes the outer SIGKILL a genuine
  // BACKSTOP: by the time it fires the trap has already forwarded TERM and KILLed
  // the inner group, so the outer signal only matters if the trap itself failed.
  // A shorter delay does not orphan the command (the trap still KILLs the inner
  // group on its own clock), but it SIGKILLs the wrapper group mid-escalation, so
  // the outside signal is wasted and the command's death is left entirely to the
  // trap's timer instead of being bounded by the killer.
  const SIGKILL_DELAY_MS = ESCALATION_SECONDS * 1000 + 500

  // Enough to distinguish a job from an unrelated process that inherited its
  // pid: a pid must wrap the whole pid space AND land in the same one-second
  // `start` bucket AND lead its own group to produce a false match.
  //
  // The command line is deliberately NOT part of this. It changes under the
  // process as it execs — a job spawned as `sh -c make` reports `sh -c make`
  // for an instant and `make` thereafter — so comparing it reports a mismatch
  // for a perfectly healthy job, and a mismatch is what stops a kill.
  export type Identity = {
    pid: number
    start: string
    pgid: number
  }

  // `ps` fields chosen for portability: `lstart` and `pgid` exist on macOS and
  // Linux, while `etimes`/`bsdstart` do not (macOS `ps` rejects `etimes`
  // outright). Exit 1 means no such process, which is how a caller learns the
  // job is gone rather than merely unmatched.
  //
  // `command` is read for diagnostics only — never for identity, per Identity.
  export async function inspect(pid: number) {
    const proc = Bun.spawn({
      cmd: ["ps", "-o", "lstart=,pgid=,command=", "-p", String(pid)],
      stdio: ["ignore", "pipe", "ignore"],
    })
    const text = await new Response(proc.stdout).text()
    if ((await proc.exited) !== 0) return undefined
    const line = text.trim()
    if (!line) return undefined
    // lstart is a ctime string containing spaces ("Wed Sep  2 07:08:55 2026"),
    // so its five fields are matched individually rather than split on
    // whitespace. Runs of spaces are tolerated throughout: a single-digit day
    // is double-spaced, and macOS pads the column where Linux does not.
    const match = line.match(/^(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\d+)\s+(.*)$/)
    if (!match) return undefined
    return { pid, start: match[1], pgid: Number(match[2]), command: match[3] }
  }

  export type Match = "alive" | "gone" | "mismatch"

  // Whether the pid still names the process the record describes.
  //
  // `mismatch` is NOT a licence to kill: the pid belongs to some unrelated
  // process now, so signalling it would kill a stranger while reporting a
  // successful reap. Callers treat it as "the job is lost", never as "kill it".
  export async function verify(identity: Identity): Promise<Match> {
    const live = await inspect(identity.pid)
    if (!live) return "gone"
    if (live.start !== identity.start) return "mismatch"
    if (live.pgid !== identity.pgid) return "mismatch"
    return "alive"
  }

  // Kill the job AND everything it spawned.
  //
  // The negative pid targets the process GROUP, which is the portable stand-in
  // for Linux's PR_SET_PDEATHSIG (macOS has no equivalent): a `make` that
  // spawned compilers dies whole, where signalling the leader alone would leave
  // them running. Jobs are spawned detached, so the leader's pid IS the group.
  //
  // Refuses on anything but an exact identity match, so a reused pid is never
  // signalled.
  export async function kill(identity: Identity): Promise<Match> {
    const match = await verify(identity)
    if (match !== "alive") {
      log.info("not killing", { pid: identity.pid, match })
      return match
    }
    signal(identity.pgid, "SIGTERM")
    await Bun.sleep(SIGKILL_DELAY_MS)
    if ((await verify(identity)) === "alive") signal(identity.pgid, "SIGKILL")
    return "alive"
  }

  function signal(pgid: number, sig: NodeJS.Signals) {
    try {
      process.kill(-pgid, sig)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      // ESRCH: the group drained between the check and the signal. Anything
      // else is a real failure worth seeing.
      if (code !== "ESRCH") log.error("signal failed", { pgid, sig, error: e })
    }
  }
}
