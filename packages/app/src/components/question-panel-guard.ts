// A press on the defocused question panel normally only grabs focus, so the
// first tap cannot auto-pick a choice. These act on the first tap instead: the
// collapse header (never picks a choice) and any shared control (submit/add,
// mic, nav arrows — a Button/IconButton, which submits or navigates rather than
// picking a choice). Any other raw button carrying no data-component, an
// option row or a question tab, is swallowed.
export function actsOnFirstPress(target: HTMLElement | null) {
  return Boolean(target?.closest('[data-question-collapse],[data-component="button"],[data-component="icon-button"]'))
}
