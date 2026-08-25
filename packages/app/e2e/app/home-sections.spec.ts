import { test, expect } from "../fixtures"

const headers = '[data-slot="list-header"]'

test("typing in the overview search cannot reorder or drop the sections", async ({ page }) => {
  await page.goto("/")

  const search = page.getByRole("textbox").first()
  await expect(search).toBeVisible()

  const before = await page.locator(headers).allTextContents()
  if (before.length < 2) test.skip()

  await search.click()
  await search.fill("zzzzzzzz")

  await expect(page.locator(headers)).toHaveCount(before.length)
  expect(await page.locator(headers).allTextContents()).toEqual(before)
})
