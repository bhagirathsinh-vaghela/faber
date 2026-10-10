import { afterEach, describe, expect, test } from "bun:test"
import { swallowClick } from "./swallow-click"

const clicks: boolean[] = []
const record = (event: MouseEvent) => clicks.push(event.defaultPrevented)

afterEach(() => {
  document.body.click()
  document.removeEventListener("click", record)
  clicks.length = 0
})

function press(button: number) {
  swallowClick(new PointerEvent("pointerdown", { button }))
  document.addEventListener("click", record)
  document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
}

describe("swallowClick", () => {
  test("a primary press eats exactly the next click", () => {
    press(0)
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    expect(clicks).toEqual([false])
  })

  test("a middle press leaves the next click alone", () => {
    press(1)
    expect(clicks).toEqual([false])
  })

  test("a right press leaves the next click alone", () => {
    press(2)
    expect(clicks).toEqual([false])
  })
})
