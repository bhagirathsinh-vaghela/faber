import { type SelectedLineRange } from "@pierre/diffs"

export function findSide(element: HTMLElement): "additions" | "deletions" | undefined {
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
