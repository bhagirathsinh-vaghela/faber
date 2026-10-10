import { test, expect } from "../fixtures"
import { modKey } from "../utils"

test("the Manage MCP servers command opens the MCP tools viewer", async ({ page, gotoSession }) => {
  await gotoSession()
  await page.locator("body").click({ position: { x: 1, y: 1 } })
  await page.keyboard.press(`${modKey}+Semicolon`)
  await expect(page.getByRole("dialog").getByText("MCP tools", { exact: true })).toBeVisible()
})
