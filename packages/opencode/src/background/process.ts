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
  export const SIGKILL_DELAY_MS = ESCALATION_SECONDS * 1000 + 500

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
  // A zombie (state Z: exited, not yet reaped by its parent) is gone: `ps -p`
  // still lists it and exits 0. LC_ALL and TZ pin lstart's format and zone, so
  // a locale or a DST change cannot turn the same process into a mismatch.
  export async function inspect(pid: number) {
    const proc = Bun.spawn({
      cmd: ["ps", "-o", "stat=,lstart=,pgid=,command=", "-p", String(pid)],
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    })
    const text = await new Response(proc.stdout).text()
    if ((await proc.exited) !== 0) return undefined
    const line = text.trim()
    if (!line) return undefined
    // lstart is a ctime string containing spaces ("Wed Sep  2 07:08:55 2026"),
    // so its five fields are matched individually rather than split on
    // whitespace. Runs of spaces are tolerated throughout: a single-digit day
    // is double-spaced, and macOS pads the column where Linux does not.
    const match = line.match(/^(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\d+)\s+(.*)$/)
    if (!match || match[1].startsWith("Z")) return undefined
    return { pid, start: match[2], pgid: Number(match[3]), command: match[4] }
  }

  // When this process started, to the second, as the OS reports it. A pid alone
  // cannot name a process across a reboot or a copied database: the number is
  // reused. Pid plus start time can.
  export const boot = Math.floor((Date.now() - performance.now()) / 1000)

  // How far apart a recorded start time and the OS's may be and still name the
  // same process. The OS dates a process from its fork; a process dates itself
  // from when its runtime came up, which a launcher can delay.
  const SKEW = 5

  // Whether the process a record names (its pid and start time) is still
  // running. A record from before start times were kept compares by pid alone.
  // Undefined when the process table could not be read: a caller about to
  // destroy or take over what the record names treats that as alive.
  export async function alive(owner: { pid: number; boot?: number }): Promise<boolean | undefined> {
    if (owner.pid === process.pid) return owner.boot === undefined || Math.abs(owner.boot - boot) <= SKEW
    const read = await Promise.resolve()
      .then(async () => {
        const proc = Bun.spawn(["ps", "-o", "stat=,lstart=", "-p", String(owner.pid)], {
          stdout: "pipe",
          stderr: "ignore",
          env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
        })
        const text = await new Response(proc.stdout).text()
        return { code: await proc.exited, text: text.trim() }
      })
      .catch((error) => {
        log.error("could not read the process table", { pid: owner.pid, error })
        return undefined
      })
    // `ps -p` exits 1 with nothing printed for a pid that does not exist.
    if (!read || (read.code !== 0 && read.code !== 1)) return undefined
    if (!read.text) return false
    // A zombie has exited, as in inspect.
    const [state = "", ...start] = read.text.split(/\s+/)
    if (state.startsWith("Z")) return false
    if (owner.boot === undefined) return true
    return Math.abs(Math.floor(new Date(start.join(" ") + " UTC").getTime() / 1000) - owner.boot) <= SKEW
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
