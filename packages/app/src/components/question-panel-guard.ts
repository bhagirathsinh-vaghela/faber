// A press on the defocused question panel normally only grabs focus, so the
// first tap cannot auto-pick a choice. These act on the first tap instead: the
// collapse header (never picks a choice) and any shared control (submit/add,
// mic, nav arrows — a Button/IconButton, which submits or navigates rather than
// picking a choice). Any other raw button carrying no data-component, an
// option row or a question tab, is swallowed.
export function actsOnFirstPress(target: HTMLElement | null) {
  return Boolean(target?.closest('[data-question-collapse],[data-component="button"],[data-component="icon-button"]'))
}

const control =
  'button,a[href],select,summary,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],[role="option"]'

// Whether a page-level key belongs to the focused element rather than the
// question. An editable field keeps every key. A control outside the panel keeps
// Enter (it presses the control) and Tab (it moves focus on); arrows still drive
// the question.
export function yields(active: Element | null, panel: Element | undefined, key: string) {
  if (!active || active === panel) return false
  if (active instanceof HTMLElement && active.isContentEditable) return true
  if (active.tagName === "TEXTAREA" || active.tagName === "INPUT") return true
  if (key !== "Enter" && key !== "Tab") return false
  if (panel?.contains(active)) return false
  return active.matches(control)
}
