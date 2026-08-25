import { test, expect } from "../fixtures"
import { promptSelector } from "../selectors"

test.describe("soft keyboard", () => {
  test.use({ hasTouch: true, isMobile: true })

  test("the editor accepts text input without suppression", async ({ page, gotoSession }) => {
    await gotoSession()

    const editor = page.locator(promptSelector)
    await expect(editor).toHaveAttribute("inputmode", "text")
  })

  test("no keyboard toggle button on touch devices", async ({ page, gotoSession }) => {
    await gotoSession()

    await expect(page.locator('button[aria-label="Show keyboard"]')).not.toBeVisible()
  })
})
