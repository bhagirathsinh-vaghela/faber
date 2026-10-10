import { test, expect } from "../fixtures"
import { openSettings } from "../actions"

// A modal dialog covers the floating reader orb: the topmost element at the
// orb's centre belongs to the dialog layer, not the orb.
test("the settings dialog covers the reader orb", async ({ page, gotoSession }) => {
  await gotoSession()

  const orb = page.getByRole("button", { name: "Reader mode", exact: true })
  await expect(orb).toBeVisible()
  const box = await orb.boundingBox()
  if (!box) throw new Error("reader orb has no box")

  await openSettings(page)

  const covered = await page.evaluate(
    (point) => !document.elementFromPoint(point.x, point.y)?.closest("[data-reader-cluster]"),
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  )
  expect(covered).toBe(true)
})
