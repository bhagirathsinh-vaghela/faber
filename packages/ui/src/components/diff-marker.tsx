import { type SelectedLineRange } from "@pierre/diffs"

export type SelectionSide = "additions" | "deletions"

// The single DOM contract with pierre's rendered diff, shared by the client
// (Diff) and SSR (Diff) components, the Code file view, and the unsafeCSS in
// ../pierre. Pierre roots a diff at [data-diff] and a file at [data-file], and
// renders each [data-code] as a gutter column and a content column side by side;
// a row in either carries data-line-index, and split rows carry a "new,old"
// pair. A version that changes any of these is a change to this file alone.
export const ROOT_SELECTOR = ":is([data-diff], [data-file])"
const LINE_SELECTOR = "[data-line], [data-alt-line]"

export function findRoot(root: ShadowRoot) {
  const element = root.querySelector(ROOT_SELECTOR)
  if (!(element instanceof HTMLElement)) return
  return element
}

export function isSplit(element: HTMLElement) {
  return element.getAttribute("data-diff-type") === "split"
}

export function findElement(node: Node | null): HTMLElement | undefined {
  if (!node) return
  if (node instanceof HTMLElement) return node
  return node.parentElement ?? undefined
}

export function findSide(node: Node | null): SelectionSide | undefined {
  const element = findElement(node)
  if (!element) return

  const typed = element.closest("[data-line-type]")
  if (typed instanceof HTMLElement) {
    const type = typed.dataset.lineType
    if (type === "change-deletion") return "deletions"
    if (type === "change-addition" || type === "change-additions") return "additions"
  }

  const code = element.closest("[data-code]")
  if (!(code instanceof HTMLElement)) return
  return code.hasAttribute("data-deletions") ? "deletions" : "additions"
}

export function findLineNumber(node: Node | null): number | undefined {
  const element = findElement(node)
  if (!element) return

  const line = element.closest(LINE_SELECTOR)
  if (!(line instanceof HTMLElement)) return

  const primary = parseInt(line.dataset.line ?? "", 10)
  if (!Number.isNaN(primary)) return primary
  const alt = parseInt(line.dataset.altLine ?? "", 10)
  if (!Number.isNaN(alt)) return alt
}

// data-line-index is "new" in unified and "new,old" in split; split reads the
// second so a deletion row maps to its old-file position.
export function lineIndex(split: boolean, element: HTMLElement) {
  const raw = element.dataset.lineIndex
  if (!raw) return
  const values = raw
    .split(",")
    .map((value) => parseInt(value, 10))
    .filter((value) => !Number.isNaN(value))
  if (values.length === 0) return
  if (!split) return values[0]
  if (values.length === 2) return values[1]
  return values[0]
}

export function rowIndex(root: ShadowRoot, split: boolean, line: number, side: SelectionSide | undefined) {
  const nodes = Array.from(root.querySelectorAll(`[data-line="${line}"], [data-alt-line="${line}"]`)).filter(
    (node): node is HTMLElement => node instanceof HTMLElement,
  )
  if (nodes.length === 0) return

  const targetSide = side ?? "additions"
  for (const node of nodes) {
    if (findSide(node) === targetSide) return lineIndex(split, node)
    if (parseInt(node.dataset.altLine ?? "", 10) === line) return lineIndex(split, node)
  }
}

// Mark every rendered row inside the selected range with data-comment-selected,
// which the unsafeCSS tints. pierre indexes rows in BOTH the gutter and content
// columns, so this walks every [data-line-index] under the root rather than the
// direct children of [data-code] — those children are the two columns, not rows.
export function applyCommentedLines(root: ShadowRoot, ranges: SelectedLineRange[]) {
  for (const node of root.querySelectorAll("[data-comment-selected]")) {
    if (node instanceof HTMLElement) node.removeAttribute("data-comment-selected")
  }

  const diffs = findRoot(root)
  if (!diffs) return

  const split = isSplit(diffs)
  const rows = Array.from(diffs.querySelectorAll("[data-line-index]")).filter(
    (node): node is HTMLElement => node instanceof HTMLElement,
  )
  if (rows.length === 0) return

  for (const range of ranges) {
    const start = rowIndex(root, split, range.start, range.side)
    if (start === undefined) continue

    const sameEnd = range.end === range.start && (range.endSide == null || range.endSide === range.side)
    const end = sameEnd ? start : rowIndex(root, split, range.end, range.endSide ?? range.side)
    if (end === undefined) continue

    const first = Math.min(start, end)
    const last = Math.max(start, end)

    for (const row of rows) {
      const idx = lineIndex(split, row)
      if (idx === undefined || idx < first || idx > last) continue
      row.setAttribute("data-comment-selected", "")
      const next = row.nextSibling
      if (next instanceof HTMLElement && next.hasAttribute("data-line-annotation")) {
        next.setAttribute("data-comment-selected", "")
      }
    }
  }
}

// Locate the line element inside the pierre diff shadow root for a selected
// range. data-line is the new-file number, data-alt-line the old-file number;
// side picks which when both exist. Returns the lower (later) of the two
// endpoints so a popover anchors to the bottom of the selection.
export function findMarker(root: ShadowRoot, range: SelectedLineRange) {
  const marker = (line: number, side?: "additions" | "deletions") => {
    const nodes = Array.from(root.querySelectorAll(`[data-line="${line}"], [data-alt-line="${line}"]`)).filter(
      (node): node is HTMLElement => node instanceof HTMLElement,
    )
    if (nodes.length === 0) return
    if (!side) return nodes[0]
    const match = nodes.find((node) => findSide(node) === side)
    return match ?? nodes[0]
  }

  const a = marker(range.start, range.side)
  const b = marker(range.end, range.endSide ?? range.side)
  if (!a) return b
  if (!b) return a
  return a.getBoundingClientRect().top > b.getBoundingClientRect().top ? a : b
}
