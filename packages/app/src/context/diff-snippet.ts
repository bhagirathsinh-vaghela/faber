import { structuredPatch } from "diff"
import type { SelectedLineRange } from "@/context/file"

type Bounds = { oldLo: number; oldHi: number; newLo: number; newHi: number }

// A selected line number indexes the OLD file when its side is "deletions" and
// the NEW file when "additions" (pierre renders old numbers as data-alt-line,
// new numbers as data-line). Translate the two selection endpoints into a window
// on each file so a snippet can be cut regardless of which side(s) the drag hit.
function bounds(range: SelectedLineRange): Bounds {
  const lo = Math.min(range.start, range.end)
  const hi = Math.max(range.start, range.end)
  const startSide = range.side ?? "additions"
  const endSide = range.endSide ?? startSide

  const b: Bounds = { oldLo: Infinity, oldHi: -Infinity, newLo: Infinity, newHi: -Infinity }
  const mark = (line: number, side: "additions" | "deletions") => {
    if (side === "deletions") {
      b.oldLo = Math.min(b.oldLo, line)
      b.oldHi = Math.max(b.oldHi, line)
      return
    }
    b.newLo = Math.min(b.newLo, line)
    b.newHi = Math.max(b.newHi, line)
  }

  // Endpoints on the same side bound that side's range directly. When the two
  // endpoints straddle sides, each endpoint bounds its own side and the snippet
  // slice fills the interior: within one hunk every line between the two hits
  // is kept. Endpoints in different hunks keep only their own lines.
  if (startSide === endSide) {
    mark(lo, startSide)
    mark(hi, startSide)
    return b
  }
  mark(range.start, startSide)
  mark(range.end, endSide)
  return b
}

// Build a standard unified-diff snippet covering the commented selection so the
// model receives exact old/new line numbers and -/+ classification, identical in
// unified and split view because it derives from before/after, not the visual
// selection. Returns undefined when there is no computable diff (unchanged file,
// missing bodies).
export function diffSnippet(before: string, after: string, range: SelectedLineRange): string | undefined {
  if (typeof before !== "string" || typeof after !== "string") return
  const patch = structuredPatch("a", "b", before, after, undefined, undefined, { context: 2 })
  if (patch.hunks.length === 0) return

  const b = bounds(range)
  const pad = 2
  const out: string[] = []

  for (const hunk of patch.hunks) {
    let oldNum = hunk.oldStart
    let newNum = hunk.newStart
    const hits: number[] = []
    const at: { old: number; new: number }[] = []

    hunk.lines.forEach((line, i) => {
      at.push({ old: oldNum, new: newNum })
      const prefix = line[0]
      const inOld = oldNum >= b.oldLo && oldNum <= b.oldHi
      const inNew = newNum >= b.newLo && newNum <= b.newHi
      if ((prefix === "-" && inOld) || (prefix === "+" && inNew) || (prefix === " " && (inOld || inNew))) hits.push(i)

      if (prefix === "-") oldNum++
      else if (prefix === "+") newNum++
      else {
        oldNum++
        newNum++
      }
    })

    if (hits.length === 0) continue
    const lo = Math.max(0, hits[0] - pad)
    const hi = Math.min(hunk.lines.length - 1, hits[hits.length - 1] + pad)
    const slice = hunk.lines.slice(lo, hi + 1)
    const olds = slice.filter((line) => line[0] === " " || line[0] === "-").length
    const news = slice.filter((line) => line[0] === " " || line[0] === "+").length
    out.push(`@@ -${at[lo].old},${olds} +${at[lo].new},${news} @@`, ...slice)
  }

  if (out.length === 0) return
  return out.join("\n")
}

// First two selected lines of a given file text, sliced at the range's numbers.
// Callers pass `before` for a deletion selection and `after` otherwise so the
// preview reads from the file the numbers actually index.
export function previewLines(content: string, range: SelectedLineRange): string | undefined {
  const start = Math.max(1, Math.min(range.start, range.end))
  const end = Math.max(range.start, range.end)
  const lines = content.split("\n").slice(start - 1, end)
  if (lines.length === 0) return
  return lines.slice(0, 2).join("\n")
}

// True when every selected line is a deletion (old-only), so attaching a slice
// of the CURRENT file at those numbers would show the wrong content.
export function isDeletionOnly(range: SelectedLineRange): boolean {
  const startSide = range.side ?? "additions"
  const endSide = range.endSide ?? startSide
  return startSide === "deletions" && endSide === "deletions"
}
