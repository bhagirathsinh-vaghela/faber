// Snapshot the element that currently holds focus and return a function that
// restores focus to it. Used by overlays that hide the focused element (zen,
// the question panel, terminals) and by the dialog provider so focus returns to
// where it was before the overlay/dialog opened, not to a fixed target.
//
// The snapshot skips body/null (no real element had focus). Restore defers one
// frame — an overlay's chrome may only re-lay-out (and become focusable) after
// it closes — and bails if the element left the DOM while the overlay was up.
export function captureFocus() {
  const active = document.activeElement as HTMLElement | null
  const target = active && active !== document.body ? active : null
  return () => {
    if (!target) return false
    if (!target.isConnected) return false
    requestAnimationFrame(() => {
      if (target.isConnected) target.focus({ preventScroll: true })
    })
    return true
  }
}
