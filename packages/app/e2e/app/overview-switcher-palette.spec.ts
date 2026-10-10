import { test, expect } from "../fixtures"
import { openPalette } from "../actions"

test("a Control release does not commit an overview opened from the palette", async ({ page, gotoSession }) => {
  await gotoSession()
  const palette = await openPalette(page)
  await palette.getByRole("textbox").first().fill("Switch to session needing attention")
  await palette
    .locator('[data-slot="list-item"]')
    .filter({ hasText: "Switch to session needing attention" })
    .first()
    .click()
  const overview = page.getByRole("dialog")
  await expect(overview.getByText("Live sessions").or(overview.getByText("Recent sessions")).first()).toBeVisible()
  await page.keyboard.down("Control")
  await page.keyboard.up("Control")
  await page.waitForTimeout(300)
  await expect(overview).toBeVisible()
})
