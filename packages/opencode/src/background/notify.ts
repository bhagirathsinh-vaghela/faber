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

  // Remove blank lines from a header value so it cannot forge the header/body
  // separator, which the reader finds at the first blank line. A run of newlines
  // (a heredoc's empty line) becomes a single one; the value's real lines are
  // kept, just never separated by a blank one. Exported because the task-result
  // writer builds the same envelope shape and needs the same guard on its own
  // `command` field — one implementation for one contract.
  export function collapse(text: string) {
    return text.replace(/(\n[ \t]*){2,}/g, "\n")
  }

  // The envelope the model reads. Its own tag, distinct from a subagent
  // task's, so a client can tell the two apart without inspecting the fields.
  export function render(job: BackgroundJob.Info, output: string, kind: Kind, now = Date.now()) {
    const elapsed = Math.round(((job.time.completed ?? now) - job.time.created) / 1000)
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
      `log: ${BackgroundJob.logPath(job.id)}`,
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
