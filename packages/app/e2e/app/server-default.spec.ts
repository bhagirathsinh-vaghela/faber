import { test, expect } from "../fixtures"
import { serverName, serverUrl } from "../utils"
import { closeDialog, clickMenuItem, openPalette } from "../actions"

const DEFAULT_SERVER_URL_KEY = "opencode.settings.dat:defaultServerUrl"

test("can set a default server on web", async ({ page, gotoSession }) => {
  await page.addInitScript((key: string) => {
    try {
      localStorage.removeItem(key)
    } catch {
      return
    }
  }, DEFAULT_SERVER_URL_KEY)

  await gotoSession()

  // The status popover shows the connected machine only; the server manager
  // moved behind the palette's "Switch server" command.
  const palette = await openPalette(page)
  await palette.getByRole("textbox").first().fill("Switch server")
  await palette.locator('[data-slot="list-item"]').filter({ hasText: "Switch server" }).first().click()

  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()

  const row = dialog.locator('[data-slot="list-item-row"]').filter({ hasText: serverName }).first()
  await expect(row).toBeVisible()

  const menuTrigger = row.locator('[data-slot="dropdown-menu-trigger"]').first()
  await expect(menuTrigger).toBeVisible()
  await menuTrigger.click({ force: true })

  const menu = page.locator('[data-component="dropdown-menu-content"]').first()
  await expect(menu).toBeVisible()
  await clickMenuItem(menu, /set as default/i)

  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), DEFAULT_SERVER_URL_KEY)).toBe(serverUrl)
  await expect(row.getByText("Default", { exact: true })).toBeVisible()

  await closeDialog(page, dialog)
})
