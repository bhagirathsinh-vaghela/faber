import { test, expect } from "../fixtures"
import { createTestProject, cleanupTestProject, openSidebar, clickMenuItem } from "../actions"
import { projectCloseMenuSelector, projectSwitchSelector } from "../selectors"
import { dirSlug } from "../utils"

test("can close a project via the icon context menu", async ({ page, withProject }) => {
  await page.setViewportSize({ width: 1400, height: 800 })

  const other = await createTestProject()
  const otherSlug = dirSlug(other)

  try {
    await withProject(
      async () => {
        await openSidebar(page)

        const otherButton = page.locator(projectSwitchSelector(otherSlug)).first()
        const closeItem = page.locator(projectCloseMenuSelector(otherSlug)).first()
        await expect(async () => {
          await expect(otherButton).toBeVisible()
          await otherButton.click({ button: "right" })
          await expect(closeItem).toBeVisible({ timeout: 2_000 })
          await closeItem.click({ timeout: 2_000 })
        }).toPass({ timeout: 30_000 })

        await expect(otherButton).toHaveCount(0, { timeout: 15_000 })
      },
      { extra: [other] },
    )
  } finally {
    await cleanupTestProject(other)
  }
})

test("can close a project via project header more options menu", async ({ page, withProject }) => {
  await page.setViewportSize({ width: 1400, height: 800 })

  const other = await createTestProject()
  const otherName = other.split("/").pop() ?? other
  const otherSlug = dirSlug(other)

  try {
    await withProject(
      async () => {
        await openSidebar(page)

        const otherButton = page.locator(projectSwitchSelector(otherSlug)).first()
        await expect(otherButton).toBeVisible()
        await otherButton.click()

        const header = page
          .locator(".group\\/project")
          .filter({ has: page.locator(`[data-action="project-menu"][data-project="${otherSlug}"]`) })
          .first()
        await expect(header).toContainText(otherName)

        const menu = page.locator('[data-component="dropdown-menu-content"]').first()
        await expect(async () => {
          const trigger = header.locator(`[data-action="project-menu"][data-project="${otherSlug}"]`).first()
          await expect(trigger).toHaveCount(1)
          await trigger.focus()
          await page.keyboard.press("Enter")
          await expect(menu).toBeVisible({ timeout: 2_000 })
        }).toPass({ timeout: 30_000 })

        await clickMenuItem(menu, /^Close$/i, { force: true })
        // The removal round-trips through the server and lands over SSE, so
        // give it more than an in-page render would need.
        await expect(otherButton).toHaveCount(0, { timeout: 15_000 })
      },
      { extra: [other] },
    )
  } finally {
    await cleanupTestProject(other)
  }
})
