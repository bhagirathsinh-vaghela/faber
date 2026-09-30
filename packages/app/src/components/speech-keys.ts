// The HUD's shortcuts capture keys page-wide, so a key meant for a field (the
// voice picker, the composer) or carrying a modifier is left to the page.
export function ignored(event: KeyboardEvent) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return true
  const target = event.target
  // True for an editing host and its editable descendants: html.spec.whatwg.org/multipage/interaction.html#dom-iscontenteditable
  if (target instanceof HTMLElement && target.isContentEditable) return true
  return target instanceof Element && Boolean(target.closest("select, input, textarea"))
}

// One of the HUD's keys is kept from the page, auto-repeats included
// (w3c.github.io/uievents/#dom-keyboardevent-repeat), and acts once per press,
// so holding Space toggles once and never scrolls the page behind.
export function handle(event: KeyboardEvent, actions: Record<string, () => void>) {
  if (ignored(event)) return
  const action = actions[event.key]
  if (!action) return
  event.preventDefault()
  event.stopPropagation()
  if (!event.repeat) action()
}
