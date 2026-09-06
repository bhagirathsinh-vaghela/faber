import { BackgroundJob } from "./job"

// The text a finished job puts into its session.
//
// Kept separate from the delivery mechanism so the decision about WHAT a
// result says is testable without a session, and so both paths that can
// deliver one (a live exit handle, a reconcile pass after a restart) produce
// byte-identical text.
export namespace BackgroundNotify {
  // Small results land whole; large ones land as a pointer the model reads on
  // demand. Two bounds rather than one, because fifty lines of minified
  // output is not small: whichever trips first wins.
  export const MAX_LINES = 50
  export const MAX_BYTES = 4_000

  export type Kind = "completed" | "timeout" | "checkin"

  // Keep a header value from forging the header/body separator, which the reader
  // finds at the first blank line. The value must never contain a blank line NOR
  // start or end with a newline: a single trailing newline abuts the next header
  // field across render's join and makes a blank line just the same. Guards the
  // job writer's `command` field below, the one header value that can carry a
  // multi-line string.
  export function collapse(text: string) {
    // Normalize CR and CRLF to LF so a `\r\n\r\n` blank line is caught too, then
    // fold any run of newlines (with whitespace between) to one and trim the
    // boundaries.
    return text
      .replace(/\r\n?/g, "\n")
      .replace(/(\n[ \t]*)+/g, "\n")
      .replace(/^\n+|\n+$/g, "")
  }

  // How long ago the log last grew, phrased for a reader. Undefined age means
  // the mtime could not be read, and the clause is then DROPPED rather than
  // guessed: a nudge claiming "log active" without knowing is worse than one
  // that gives only elapsed.
  function freshness(logAge: number | undefined) {
    if (logAge === undefined) return undefined
    const seconds = Math.max(0, Math.round(logAge / 1000))
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m`
    return `${Math.floor(minutes / 60)}h`
  }

  // The nudge's dismissibility lives entirely in this prose, so it is the load-
  // bearing part. The first nudge for a job spells out the whole contract — no
  // action needed, check via a todo without dropping the current step, ignore
  // otherwise — because a synthetic user turn's default pull is "act now", which
  // has to be actively lowered. Every repeat is the tighter form: the contract
  // is established, and a bare re-explanation each time is the bloat that trains
  // a reader to skim past all of them.
  function note(ordinal: number, log: string) {
    if (ordinal <= 1)
      return (
        `No action needed — this is an FYI, not a request. You launched this job, so you know roughly ` +
        `how long it should take; if it looks stalled you can tail ${log} to check, kill it, or raise its ` +
        `deadline. If you do look, do NOT abandon your current work: add a todo for the check and finish ` +
        `what you're on first. Otherwise ignore this and keep going.`
      )
    return `FYI only. Stalled-looking? Tail ${log} as a todo, don't drop your current step. Else ignore.`
  }

  // The envelope the model reads. Its own tag, distinct from a subagent
  // task's, so a client can tell the two apart without inspecting the fields.
  //
  // `logAge` (ms since the log last grew) is the nudge's freshness delta and is
  // only meaningful for a check-in; the completion paths pass nothing and the
  // clause is dropped.
  export function render(
    job: BackgroundJob.Info,
    output: string,
    kind: Kind,
    now = Date.now(),
    logAge?: number | undefined,
  ) {
    const elapsed = Math.round(((job.time.completed ?? now) - job.time.created) / 1000)
    const grew = kind === "checkin" ? freshness(logAge) : undefined
    const head = [
      `<background-job-result>`,
      `job_id: ${job.id}`,
      // The reader finds the header/body boundary at the first blank line, and
      // `command` is the one header field that carries arbitrary user text: a
      // heredoc with an empty line would put a blank line INSIDE the header, so
      // the reader would cut there and render the rest of the header as output.
      // Collapsing blank lines keeps the command readable and multi-line while
      // guaranteeing the only blank line in the envelope is the real separator.
      `command: ${collapse(job.command)}`,
      kind === "checkin" ? `status: still running after ${elapsed}s` : `status: ${status(job, kind)}`,
      kind === "checkin" ? undefined : `exit: ${job.exit ?? "unknown"}`,
      `duration: ${elapsed}s`,
      grew ? `log last grew: ${grew} ago` : undefined,
      `log: ${BackgroundJob.logPath(job.id)}`,
      kind === "checkin" ? `note: ${note(job.time.nudges ?? 1, BackgroundJob.logPath(job.id))}` : undefined,
    ].filter((line): line is string => line !== undefined)

    const tail = [``, ...body(output, kind), `</background-job-result>`]
    return [...head, ...tail].join("\n")
  }

  // What the card's styled header shows. The status is the reader's headline:
  // a check-in reads as running rather than borrowing a finished job's word,
  // and a watchdog kill is named rather than shown as the command failing.
  export function meta(job: BackgroundJob.Info, kind: Kind, now = Date.now()) {
    return {
      jobId: job.id,
      command: job.command,
      description: job.description,
      status: kind === "checkin" ? ("running" as const) : kind === "timeout" ? ("timeout" as const) : statusWord(job),
      exit: job.exit,
      log: BackgroundJob.logPath(job.id),
      duration: (job.time.completed ?? now) - job.time.created,
    }
  }

  // An absent exit code is UNKNOWN, not a failure. A job killed before it could
  // write its own exit file leaves none, so treating the absence as non-zero
  // claims the command failed when nothing knows whether it did. The record
  // keeps the two apart and the reader has to as well, the same way `time.lost`
  // is kept apart from `status`.
  function statusWord(job: BackgroundJob.Info) {
    if (job.exit === undefined) return "ended" as const
    return job.exit === 0 ? ("completed" as const) : ("failed" as const)
  }

  function status(job: BackgroundJob.Info, kind: Kind) {
    if (kind === "timeout") return "killed after exceeding its time limit"
    if (job.exit === undefined) return "ended without recording an exit code"
    return job.exit === 0 ? "completed" : "failed"
  }

  function body(output: string, kind: Kind) {
    if (!output.trim()) return ["(no output)"]

    const lines = output.split("\n")
    const bytes = Buffer.byteLength(output, "utf-8")
    // A check-in is about progress, so it always shows the tail rather than
    // the head: the interesting part of a running job is where it has got to.
    if (kind === "checkin") return [`(last ${Math.min(MAX_LINES, lines.length)} lines)`, ...lines.slice(-MAX_LINES)]

    if (lines.length <= MAX_LINES && bytes <= MAX_BYTES) return [output.trimEnd()]

    // The full output stays on disk and the path is in the header, so nothing
    // is lost by pointing rather than pasting. The tail is what a failing
    // build puts its error in.
    return [
      `(${lines.length} lines, ${bytes} bytes — full output in the log above; last ${MAX_LINES} lines follow)`,
      ``,
      ...lines.slice(-MAX_LINES),
    ]
  }
}
