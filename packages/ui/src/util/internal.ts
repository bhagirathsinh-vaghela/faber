// Whether a synthetic text part is machinery written for the model rather than
// content written for the reader.
//
// Machinery carries `internal`, set by the writer, and a part carrying the flag
// is judged by the flag alone. A part without one is recognised by the shape it
// opens with, so the heuristic never overrides the flag and applies only in its
// absence.
//
// Its own module because two components must reach the SAME verdict: the
// renderer that decides what to draw, and the classifier that decides which box
// type a message is. A part hidden by one and keyed visible by the other draws
// an empty box.
const LEGACY_INTERNAL = [
  "<!--",
  "<system-reminder>",
  "<mcp_tool_catalog>",
  "<background-",
  "Called the ",
  // These two land on the USER'S OWN message rather than a message of their
  // own, and the transcript draws one part per message. An unflagged one is
  // therefore not merely an extra box: it is drawn INSTEAD of the prompt the
  // user typed, leaving the typed text unreachable.
  "<session_context_update>",
  "<project_subagents>",
]

export function legacyInternal(part: { text: string; internal?: boolean }) {
  if (part.internal !== undefined) return false
  const text = part.text.trimStart()
  return LEGACY_INTERNAL.some((prefix) => text.startsWith(prefix))
}
