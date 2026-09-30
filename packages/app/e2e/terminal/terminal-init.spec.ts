import { test, expect } from "../fixtures"
import { promptSelector, terminalSelector } from "../selectors"
import { terminalToggleKey } from "../utils"

// In its own project: the server disposes a project's instance, terminals
// included, 3s after its last busy or ping-armed session goes idle
// (`Liveness`), and parallel specs end sessions in the shared one.
test("smoke terminal mounts and can create a second tab", async ({ page, withProject }) => {
  await withProject(async () => {
    const terminals = page.locator(terminalSelector)
    const opened = await terminals.first().isVisible()

    if (!opened) {
      await page.keyboard.press(terminalToggleKey)
    }

    await expect(terminals.first()).toBeVisible()
    await expect(terminals.first().locator("textarea")).toHaveCount(1)
    await expect(terminals).toHaveCount(1)

    // Ghostty captures a lot of keybinds when focused; move focus back
    // to the app shell before triggering `terminal.new`.
    await page.locator(promptSelector).click()
    await page.keyboard.press("Control+Alt+T")

    await expect(terminals).toHaveCount(2)
    await expect(terminals.nth(1).locator("textarea")).toHaveCount(1)
  })
})
