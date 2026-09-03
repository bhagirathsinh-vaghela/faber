// The visual vocabulary of a background-job result — accent, glyph, label, and
// text colour per status. Pure string mappings, in their own module rather than
// beside the renderer: the renderer pulls in the DOM/markdown stack, so a test
// reaching these through it cannot run headless.
//
// Every status the job writer can emit must have a branch here. `ended` is the
// one that bites: a job killed before it wrote its exit code recorded no
// outcome (BackgroundNotify.statusWord returns "ended" for an undefined exit),
// so it is NOT a success and must never wear the ✓ / "JOB DONE" / finished
// colour the default branch gives.

// A shell job carries its own accent so it is not read as a subagent task at a
// glance: one ran a command, the other reasoned.
const JOB_ACCENT = "var(--box-accent-job)"

// `--syntax-critical` rather than a `--color-*-error` token: those are unset in
// the shipped themes, and an unresolvable accent leaves the box drawing its
// default white border, which reads as an ordinary message.
export function jobAccent(status: string): string {
  if (status === "failed" || status === "timeout") return "var(--syntax-critical)"
  if (status === "running") return "var(--syntax-constant)"
  // Muted, like the jobs page: an unknown exit is neither success nor failure,
  // so it must not borrow the job accent that reads as a completed run.
  if (status === "ended") return "var(--text-weak)"
  return JOB_ACCENT
}

// Icon and word together, since colour alone excludes a reader who cannot
// distinguish it. Each status keeps one glyph everywhere it appears.
export function jobGlyph(status: string): string {
  if (status === "failed") return "✗"
  if (status === "timeout") return "⏱"
  if (status === "running") return "◐"
  // A job killed before it wrote its exit code recorded no outcome, so it is
  // not a success: `ended` gets a neutral glyph, never the ✓.
  if (status === "ended") return "•"
  return "✓"
}

// A timeout is a distinct outcome from a command that failed on its own, and a
// reader acts differently on each, so it is named rather than folded in.
export function jobLabel(status: string): string {
  if (status === "timeout") return "JOB TIMED OUT"
  if (status === "running") return "JOB RUNNING"
  if (status === "failed") return "JOB FAILED"
  if (status === "ended") return "JOB ENDED (EXIT UNKNOWN)"
  return "JOB DONE"
}

export function jobStatusColor(status: string): string {
  if (status === "failed" || status === "timeout") return "var(--syntax-critical)"
  // A check-in reports a job still going, so it must not wear the colour that
  // means finished.
  if (status === "running") return "var(--syntax-constant)"
  // An unknown exit is not a success; muted, so it does not wear the finished
  // colour.
  if (status === "ended") return "var(--text-weak)"
  return "var(--syntax-string)"
}
