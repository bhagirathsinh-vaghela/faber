import { test, expect } from "../fixtures"
import { promptSelector } from "../selectors"

// The dock suppresses the soft keyboard on touch (inputmode="none", so dictation
// owns the editor) until the keyboard button opts in. Raising it has to survive
// the browser's own focus churn: the opt-in is driven by a focus bounce, and the
// OS emits a further blur when the keyboard finishes animating in. Any of that
// churn resetting the opt-in reverts inputmode and drops the keyboard that was
// just raised, which reads as a keyboard flashing up and going straight back down.

const KEYBOARD_BUTTON = 'button[aria-label="Show keyboard"]'

test.describe("soft keyboard opt-in", () => {
  test.use({ hasTouch: true, isMobile: true })

  test("the editor is dictation-first until the keyboard button opts in", async ({ page, gotoSession }) => {
    await gotoSession()

    const editor = page.locator(promptSelector)
    await expect(editor).toHaveAttribute("inputmode", "none")
    await expect(page.locator(KEYBOARD_BUTTON)).toBeVisible()
  })

  test("the bounce target can raise a keyboard of its own", async ({ page, gotoSession }) => {
    await gotoSession()

    // The bounce exists to give the editor a fresh focus, which is the only
    // point the keyboard type is read. An unrendered or off-screen element is
    // not offered a keyboard at all, so such a bounce silently does nothing.
    const bounce = await page.evaluate(() => {
      const el = document.querySelector<HTMLInputElement>('input[aria-hidden="true"][tabindex="-1"]')
      if (!el) return null
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return {
        inputmode: el.getAttribute("inputmode"),
        display: style.display,
        visibility: style.visibility,
        onScreen: rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight,
      }
    })

    expect(bounce, "the dock must render a bounce target").not.toBeNull()
    expect(bounce!.onScreen, "an off-screen bounce target is offered no keyboard").toBe(true)
    expect(bounce!.display).not.toBe("none")
    expect(bounce!.visibility).not.toBe("hidden")
    // A bounce asking for a different keyboard than the editor requests one and
    // then another within a single gesture, which is itself a dismissal.
    expect(bounce!.inputmode, "the bounce must ask for the same keyboard as the editor").toBe("text")
  })

  test("the opt-in outlives the focus churn of raising the keyboard", async ({ page, gotoSession }) => {
    await gotoSession()

    const editor = page.locator(promptSelector)
    await expect(editor).toHaveAttribute("inputmode", "none")

    await page.locator(KEYBOARD_BUTTON).dispatchEvent("pointerdown")
    await expect(editor).toHaveAttribute("inputmode", "text")

    // A blur landing mid-animation is the OS settling the keyboard it was asked
    // for, not the user leaving the field, so it must not revert the opt-in.
    await page.waitForTimeout(200)
    await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-component="prompt-input"]')!
      el.blur()
      el.focus()
    })

    await page.waitForTimeout(200)
    await expect(editor, "the keyboard must still be asked for once the OS settles").toHaveAttribute(
      "inputmode",
      "text",
    )
  })

  test("a second tap on the button cannot take the keyboard back down", async ({ page, gotoSession }) => {
    await gotoSession()

    const editor = page.locator(promptSelector)
    const button = page.locator(KEYBOARD_BUTTON)

    await button.tap()
    await expect(editor).toHaveAttribute("inputmode", "text")

    // The editor must hold focus across every press of this button, including
    // one whose action is declined as a duplicate.
    await page.waitForTimeout(100)
    await button.tap()
    await page.waitForTimeout(300)

    const stolen = await page.evaluate(
      () => document.activeElement !== document.querySelector('[data-component="prompt-input"]'),
    )
    expect(stolen, "the editor must keep focus across a repeated press").toBe(false)
    await expect(editor, "the keyboard must survive a repeated press").toHaveAttribute("inputmode", "text")
  })

  test("the button raises the keyboard again after a dismissal that kept focus", async ({ page, gotoSession }) => {
    await gotoSession()

    const editor = page.locator(promptSelector)
    const button = page.locator(KEYBOARD_BUTTON)

    await button.tap()
    await expect(editor).toHaveAttribute("inputmode", "text")
    await page.waitForTimeout(700)

    // The keyboard's own hide key takes the keyboard without blurring the
    // editor, so the state a second press starts from still says "text" and
    // still holds focus. Pressing from there must be as effective as pressing
    // from cold, or the raise is a write of values that are already set.
    const raise = await page.evaluate(async () => {
      const el = document.querySelector('[data-component="prompt-input"]') as HTMLElement
      const editableStates: string[] = []
      const observer = new MutationObserver(() => editableStates.push(el.contentEditable))
      observer.observe(el, { attributes: true, attributeFilter: ["contenteditable"] })
      document
        .querySelector<HTMLElement>('button[aria-label="Show keyboard"]')!
        .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }))
      await new Promise((r) => setTimeout(r, 50))
      observer.disconnect()
      return { editableStates, focused: document.activeElement === el, editableNow: el.contentEditable }
    })

    expect(raise.editableStates.length, "the editable must be withdrawn so focus is granted afresh").toBeGreaterThan(0)
    expect(raise.focused, "the editor ends up focused").toBe(true)
    expect(raise.editableNow, "the editor stays editable").toBe("true")
    await expect(editor).toHaveAttribute("inputmode", "text")
  })

  test("leaving the editor restores the dictation-first default", async ({ page, gotoSession }) => {
    await gotoSession()

    await page.locator(KEYBOARD_BUTTON).dispatchEvent("pointerdown")
    await expect(page.locator(promptSelector)).toHaveAttribute("inputmode", "text")

    // Past the raise, a blur is the user actually leaving, and the next focus
    // owes them dictation rather than a keyboard they never asked for again.
    await page.waitForTimeout(700)
    await page.evaluate(() => document.querySelector<HTMLElement>('[data-component="prompt-input"]')!.blur())

    await expect(page.locator(promptSelector)).toHaveAttribute("inputmode", "none")
  })
})
