import { test, expect } from "../fixtures"
import { openPalette } from "../actions"

test("the palette lists Focus prompt once", async ({ page, gotoSession }) => {
  await gotoSession()
  const dialog = await openPalette(page)
  await dialog.getByRole("textbox").first().fill("Focus prompt")
  const rows = dialog.locator('[data-slot="list-item"]').filter({ hasText: "Focus prompt" })
  await expect(rows.first()).toBeVisible()
  await expect(rows).toHaveCount(1)
})
