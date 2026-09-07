import { test, expect } from "../fixtures"
import { promptSelector } from "../selectors"

test.describe("soft keyboard", () => {
  test.use({ hasTouch: true, isMobile: true })

  // Playwright runs Desktop Chrome, so `(pointer: coarse)` reports false and the
  // dock's coarse-only focus gating never engages. Force it true, since that is
  // what decides whether the mic hands the caret to the editor (dock focuses it
  // on a fine pointer, leaves it alone on a coarse one).
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const real = window.matchMedia.bind(window)
      window.matchMedia = (query) => {
        const list = real(query)
        if (/pointer:\s*coarse|hover:\s*none/.test(query)) Object.defineProperty(list, "matches", { get: () => true })
        return list
      }
    })
  })

  test("a tap on the editor focuses it", async ({ page, gotoSession }) => {
    await gotoSession()

    const editor = page.locator(promptSelector)
    await editor.tap()
    await expect(editor).toBeFocused()
  })

  test("the mic does not focus the editor", async ({ page, gotoSession }) => {
    await gotoSession()

    const mic = page.locator('button[aria-label="Dictate"]')
    test.skip((await mic.count()) === 0, "dictation unsupported in this browser")

    // A touch load leaves the editor unfocused (no keyboard rises on its own);
    // the harness focuses it on open, so start from the real device state.
    const editor = page.locator(promptSelector)
    await editor.evaluate((el) => el.blur())
    await expect(editor).not.toBeFocused()

    // The label flips to "Stop dictation" once the tap starts dictation, so its
    // disappearance proves the tap did something and "still unfocused" is not vacuous.
    await mic.tap()
    await expect(mic).toHaveCount(0)
    await expect(editor).not.toBeFocused()
  })

  test("the editor asks for a text keyboard", async ({ page, gotoSession }) => {
    await gotoSession()

    await expect(page.locator(promptSelector)).toHaveAttribute("inputmode", "text")
  })
})

test.describe("soft keyboard with a mouse", () => {
  test("a programmatic focus is honoured on a fine pointer", async ({ page, gotoSession }) => {
    await gotoSession()

    const editor = page.locator(promptSelector)
    await page.evaluate((selector) => (document.querySelector(selector) as HTMLElement).focus(), promptSelector)
    await expect(editor).toBeFocused()
  })
})

test.describe("caret placement", () => {
  const caretOffset = async (page: import("@playwright/test").Page) =>
    page.evaluate((selector) => {
      const editor = document.querySelector(selector) as HTMLElement
      const selection = window.getSelection()
      if (!selection || selection.rangeCount === 0) return -1
      const range = selection.getRangeAt(0).cloneRange()
      range.selectNodeContents(editor)
      range.setEnd(selection.getRangeAt(0).endContainer, selection.getRangeAt(0).endOffset)
      return range.toString().length
    }, promptSelector)

  test("a click past the end of the text lands the caret at the end", async ({ page, gotoSession }) => {
    await gotoSession()

    const editor = page.locator(promptSelector)
    await editor.click()
    await page.keyboard.type("hello world")
    await page.keyboard.press("ArrowLeft")
    await page.keyboard.press("ArrowLeft")
    await page.keyboard.press("ArrowLeft")
    await page.keyboard.type("X")
    const edited = "hello woXrld"
    expect(await caretOffset(page)).toBe(9)

    const box = (await editor.boundingBox())!
    await page.mouse.click(box.x + box.width - 4, box.y + box.height - 2)
    expect(await caretOffset(page)).toBe(edited.length)
  })

  test("a click on the text keeps the browser's own placement", async ({ page, gotoSession }) => {
    await gotoSession()

    const editor = page.locator(promptSelector)
    await editor.click()
    await page.keyboard.type("hello world")

    const box = (await editor.boundingBox())!
    await page.mouse.click(box.x + 2, box.y + box.height / 2)
    expect(await caretOffset(page)).toBeLessThan("hello world".length)
  })
})

test.describe("caret visibility", () => {
  test("the dock overrides the shell's user-select so WebKit paints a caret", async ({ page, gotoSession }) => {
    await gotoSession()

    // WebKit paints no caret when any ancestor computes user-select:none, even
    // where the editable element itself overrides it (WebKit bug 82692).
    const chain = await page.evaluate((selector) => {
      const out: string[] = []
      let el: HTMLElement | null = document.querySelector(selector)
      while (el && el !== document.documentElement) {
        out.push(getComputedStyle(el).webkitUserSelect)
        if (el.dataset.slot === "prompt-dock") break
        el = el.parentElement
      }
      return out
    }, promptSelector)

    expect(chain.length).toBeGreaterThan(1)
    expect(chain).not.toContain("none")
  })
})
