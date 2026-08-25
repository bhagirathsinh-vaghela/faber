import type { Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import { hoverRow } from "../actions"
import { popoverCursorSelector, popoverHoveredSelector, promptSelector } from "../selectors"

async function openSlash(page: Page, text: string) {
  await page.locator(promptSelector).click()
  await page.keyboard.type(text)
  await expect(page.locator(popoverCursorSelector)).toHaveCount(1)
}

test("the best match takes the keyboard cursor as you type", async ({ page, gotoSession }) => {
  await gotoSession()
  await openSlash(page, "/open")

  await expect(page.locator(popoverCursorSelector)).toHaveAttribute("data-slash-id", "file.open")
})

// The cursor decides what Enter submits and the pointer must not move it, or a
// mouse resting anywhere over the list silently rebinds the Enter key.
test("hovering marks a row without moving the keyboard cursor", async ({ page, gotoSession }) => {
  await gotoSession()
  await openSlash(page, "/")

  const cursor = page.locator(popoverCursorSelector)
  const before = await cursor.getAttribute("data-slash-id")

  const other = page.locator(`[data-popover-item]:not([data-slash-id="${before}"])`).first()
  const hoveredID = await other.getAttribute("data-slash-id")
  await hoverRow(page, other)

  await expect(page.locator(popoverHoveredSelector)).toHaveAttribute("data-slash-id", hoveredID!)
  await expect(cursor).toHaveAttribute("data-slash-id", before!)
  await expect(cursor).toHaveCount(1)
})

test("arrow keys move the cursor while the pointer stays put", async ({ page, gotoSession }) => {
  await gotoSession()
  await openSlash(page, "/")

  const cursor = page.locator(popoverCursorSelector)
  const first = await cursor.getAttribute("data-slash-id")

  await hoverRow(page, page.locator(`[data-slash-id="${first}"]`))
  await page.keyboard.press("ArrowDown")

  await expect(cursor).not.toHaveAttribute("data-slash-id", first!)
  await expect(page.locator(popoverHoveredSelector)).toHaveAttribute("data-slash-id", first!)
})

// Enter belongs to the cursor even while the pointer marks a different row.
test("enter runs the cursor row, not the hovered one", async ({ page, gotoSession }) => {
  await gotoSession()
  await openSlash(page, "/open")

  const other = page.locator('[data-popover-item]:not([data-slash-id="file.open"])').first()
  if (await other.count()) await hoverRow(page, other)

  await page.keyboard.press("Enter")

  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("textbox").first()).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
})

// Clicking follows the pointer, so a row the cursor is not on still runs.
test("clicking runs the clicked row", async ({ page, gotoSession }) => {
  await gotoSession()
  await openSlash(page, "/")

  const target = page.locator('[data-slash-id="file.open"]')
  await expect(target).toBeVisible()
  await target.click()

  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
})
