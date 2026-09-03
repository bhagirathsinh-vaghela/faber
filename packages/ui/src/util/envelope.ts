// Reading a delivered result's body back out of the envelope its writer built.
//
// Pure string work, in its own module rather than beside the renderer: the
// renderer pulls in the markdown stack, which needs a DOM, so a test reaching
// these through it cannot run headless.

export function stripTaskMeta(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim()
      // The opaque IDs carry nothing a reader can act on. Everything else
      // (agent, toolset, summary, status, duration) is surfaced as styled
      // fields, so it comes OUT of the raw body and renders as UI instead.
      if (trimmed.startsWith("task_id:")) return false
      if (trimmed.startsWith("session_id:")) return false
      if (trimmed.startsWith("Background task started:")) return false
      if (trimmed.startsWith("agent:")) return false
      if (trimmed.startsWith("toolset:")) return false
      if (trimmed.startsWith("summary:")) return false
      if (trimmed.startsWith("type: subagent")) return false
      if (trimmed.startsWith("status:")) return false
      if (trimmed.startsWith("duration:")) return false
      if (trimmed === "Results will be delivered when the task completes.") return false
      return true
    })
    .join("\n")
    .trim()
}

// Split at the writer's own separator, for the reason `stripJobResult` does: a
// task whose output contains a line beginning `status:` loses it otherwise.
export function stripTaskResult(text: string): string {
  const match = text.match(/<background-task-result>([\s\S]*?)<\/background-task-result>/)
  if (!match) return stripTaskMeta(text)
  const envelope = match[1].replace(/^\n/, "")
  const separator = envelope.indexOf("\n\n")
  return (separator === -1 ? stripTaskMeta(envelope) : envelope.slice(separator + 2)).trim()
}

// The job header's field lines, dropped by prefix. This is the FALLBACK for a
// malformed envelope with no separator, mirroring stripTaskMeta: the writer
// always emits the blank line, so the separator split below is the real path
// and this only runs when it is absent. Prefix-matching would wrongly delete an
// output line shaped like a field, which is exactly why it is not the primary
// path.
function stripJobMeta(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim()
      if (trimmed.startsWith("job_id:")) return false
      if (trimmed.startsWith("command:")) return false
      if (trimmed.startsWith("status:")) return false
      if (trimmed.startsWith("exit:")) return false
      if (trimmed.startsWith("duration:")) return false
      if (trimmed.startsWith("log:")) return false
      return true
    })
    .join("\n")
    .trim()
}

// A job's header lines, every one of which the card shows as a styled field.
// Leaving them in the body would print each twice.
//
// Split at the BLANK LINE the writer puts between its header and the body, not
// by recognising header lines. The writer builds a fixed array and joins one
// empty string before the output, so that separator is where the header ends,
// exactly. Matching prefixes instead re-derives a boundary the writer already
// declared, and the two answers differ in both directions: an output line
// beginning `status:` is deleted from the body (a grep for `command:` loses the
// lines it was run to find), and a multi-line command puts its own tail below
// the `command:` line, where nothing matches, so the command's source renders
// as the result.
export function stripJobResult(text: string): string {
  const match = text.match(/<background-job-result>([\s\S]*?)<\/background-job-result>/)
  const envelope = (match ? match[1] : text).replace(/^\n/, "")
  const separator = envelope.indexOf("\n\n")
  return (separator === -1 ? stripJobMeta(envelope) : envelope.slice(separator + 2)).trim()
}
