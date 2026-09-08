// Callout container directives (`:::name … :::`): names, labels and the line
// scanners the markdown renderer uses.
// `check` folds shut as a self-test; the rest render as an aside with the label.

export const CALLOUTS = {
  fix: "Correction",
  anchor: "Anchor",
  key: "Key point",
  tangent: "Tangent",
  check: "Check yourself",
} as const

export type CalloutName = keyof typeof CALLOUTS

export const CALLOUT_NAMES = Object.keys(CALLOUTS) as CalloutName[]

const OPEN = new RegExp(String.raw`^:::(${CALLOUT_NAMES.join("|")})(?:\[[^\]]*\])?\s*` + "$")
const CLOSE = new RegExp(String.raw`^:::\s*` + "$")
const FENCE = /^\s*(```|~~~)/

// Whether a single line opens or closes a callout, exported so a splitter can
// track callout depth token by token without re-deriving the patterns.
export function opensCallout(line: string) {
  return OPEN.test(line.replace(/\r$/, ""))
}
export function closesCallout(line: string) {
  return CLOSE.test(line.replace(/\r$/, ""))
}

// Depth of unmatched `:::name` openers at the end of `text`, and the byte offset
// of the outermost still-open one. A `:::` inside a fenced code block is literal
// text, not a directive, so fence lines toggle a skip state and everything
// between them is ignored. depth 0 means every opener has its closer.
export function scanCalloutDepth(text: string): { depth: number; openOffset: number } {
  let depth = 0
  let openOffset = -1
  let offset = 0
  let inFence = false
  for (const line of text.split("\n")) {
    const trimmed = line.replace(/\r$/, "")
    if (FENCE.test(trimmed)) inFence = !inFence
    else if (!inFence) {
      if (OPEN.test(trimmed)) {
        if (depth === 0) openOffset = offset
        depth++
      } else if (CLOSE.test(trimmed) && depth > 0) {
        depth--
        if (depth === 0) openOffset = -1
      }
    }
    offset += line.length + 1
  }
  return { depth, openOffset }
}
