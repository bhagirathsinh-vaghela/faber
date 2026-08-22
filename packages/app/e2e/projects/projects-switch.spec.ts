import { test, expect } from "../fixtures"
import { createTestProject, cleanupTestProject, openSidebar } from "../actions"
import { projectSwitchSelector } from "../selectors"
import { dirSlug } from "../utils"

test("can switch between projects from sidebar", async ({ page, withProject }) => {
  await page.setViewportSize({ width: 1400, height: 800 })

  const other = await createTestProject()
  const otherSlug = dirSlug(other)

  // A project icon click previews its sessions in the panel without
  // navigating; the panel's New session button is what changes the route.
  const switchTo = async (slug: string) => {
    const icon = page.locator(projectSwitchSelector(slug)).first()
    await expect(icon).toBeVisible()
    await icon.click()
    await page.getByRole("button", { name: "New session" }).first().click()
    await expect(page).toHaveURL(new RegExp(`/${slug}/session`))
  }

  try {
    await withProject(
      async ({ directory }) => {
        await openSidebar(page)

        await switchTo(otherSlug)
        await switchTo(dirSlug(directory))
      },
      { extra: [other] },
    )
  } finally {
    await cleanupTestProject(other)
  }
})
