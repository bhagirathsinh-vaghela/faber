// Eats the click that a press is about to deliver, so the element under the
// pointer never receives it. Only the primary button produces a click; the
// others produce auxclick
// (https://developer.mozilla.org/en-US/docs/Web/API/Element/auxclick_event), so
// arming on them would leave the listener waiting to eat a later, unrelated click.
export function swallowClick(press: PointerEvent) {
  if (press.button !== 0) return
  const swallow = (click: MouseEvent) => {
    click.preventDefault()
    click.stopPropagation()
    document.removeEventListener("click", swallow, true)
  }
  document.addEventListener("click", swallow, true)
}
