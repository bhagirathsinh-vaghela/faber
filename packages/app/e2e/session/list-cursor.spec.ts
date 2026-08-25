import { test, expect } from "../fixtures"
import { closeDialog, hoverRow, openPalette } from "../actions"
import { listItemSelector } from "../selectors"

const cursor = `${listItemSelector}[data-active="true"]`
const hovered = `${listItemSelector}[data-hovered="true"]`

test("the search list keeps the pointer and the keyboard cursor apart", async ({ page, gotoSession }) => {
  await gotoSession()
  const dialog = await openPalette(page)

  const rows = dialog.locator(listItemSelector)
  await expect(rows.first()).toBeVisible()
  if ((await rows.count()) < 2) test.skip()

  await expect(dialog.locator(cursor)).toHaveCount(1)
  const before = await dialog.locator(cursor).getAttribute("data-key")

  const other = dialog.locator(`${listItemSelector}:not([data-key="${before}"])`).first()
  const hoveredKey = await other.getAttribute("data-key")
  await hoverRow(page, other)

  await expect(dialog.locator(hovered)).toHaveAttribute("data-key", hoveredKey!)
  await expect(dialog.locator(cursor)).toHaveAttribute("data-key", before!)

  await page.keyboard.press("ArrowDown")
  await expect(dialog.locator(cursor)).not.toHaveAttribute("data-key", before!)
  await expect(dialog.locator(hovered)).toHaveAttribute("data-key", hoveredKey!)

  await closeDialog(page, dialog)
})

test("filtering the search list moves the cursor to the best match", async ({ page, gotoSession }) => {
  await gotoSession()
  const dialog = await openPalette(page)

  const rows = dialog.locator(listItemSelector)
  await expect(rows.first()).toBeVisible()

  const title = (await rows.first().textContent())?.trim() ?? ""
  if (title.length < 3) test.skip()

  await page.keyboard.type(title.slice(0, 3))
  await expect(dialog.locator(cursor)).toHaveCount(1)
  const best = await rows.first().getAttribute("data-key")
  await expect(dialog.locator(cursor)).toHaveAttribute("data-key", best!)

  await closeDialog(page, dialog)
})
