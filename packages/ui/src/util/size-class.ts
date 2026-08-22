// The single definition of the shell size classes: the storage key, the media
// queries, and the classification. Consumed by two very different callers —
// util/shell.ts (the reactive signal) and the app's generated pre-paint script
// — so it must stay dependency-free and side-effect-free.

export type SizeClass = "compact" | "medium" | "expanded"

// sessionStorage, not localStorage: a pinned layout belongs to the tab that
// pinned it. Each client connected to the server decides its own view, and a
// pin in one tab must not leak into the next.
export const SIZE_CLASS_KEY = "opencode-size-class"

// Material 3 window size classes, in CSS px. Width and height are classified
// separately: 600 splits phone from tablet, 840 splits tablet from desktop. A
// wide-but-short window (landscape phone, dragged-flat desktop window) has the
// width for a third pane and nowhere to put its contents, so height demotes it.
export const SIZE_QUERIES = {
  medium: "(min-width: 600px)",
  expanded: "(min-width: 840px) and (min-height: 480px)",
} as const

export function parseSizeClass(value: string | null): SizeClass | undefined {
  if (value === "compact" || value === "medium" || value === "expanded") return value
  return undefined
}

export function measureSizeClass(matches: { medium: boolean; expanded: boolean }): SizeClass {
  if (matches.expanded) return "expanded"
  if (matches.medium) return "medium"
  return "compact"
}
