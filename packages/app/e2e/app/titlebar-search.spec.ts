import type { Page } from "@playwright/test"
import { test, expect } from "../fixtures"

// File search needs a session's file.open command, so the compact titlebar
// offers it in a session and nowhere else.
test.describe("titlebar file search", () => {
  test.use({ viewport: { width: 430, height: 900 } })

  const search = (page: Page) =>
    page.locator('[data-slot="titlebar"]').getByRole("button", { name: "Search files" }).locator("visible=true")

  test("is absent on home", async ({ page }) => {
    await page.goto("/")
    await expect(page.getByRole("button", { name: "Home" }).first()).toBeVisible()
    await expect(search(page)).toHaveCount(0)
  })

  test("is shown in a session", async ({ page, gotoSession }) => {
    await gotoSession()
    await expect(search(page)).toHaveCount(1)
  })
})
