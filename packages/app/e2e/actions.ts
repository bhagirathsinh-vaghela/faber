import { expect, type Locator, type Page } from "@playwright/test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execSync } from "node:child_process"
import { modKey } from "./utils"
import {
  sessionItemSelector,
  dropdownMenuTriggerSelector,
  dropdownMenuContentSelector,
  projectMenuTriggerSelector,
  titlebarSelector,
  titlebarRightSelector,
  popoverBodySelector,
  listItemSelector,
  listItemKeySelector,
  listItemKeyStartsWithSelector,
} from "./selectors"
import type { createSdk } from "./utils"

export async function defocus(page: Page) {
  await page.mouse.click(5, 5)
}

// locator.hover() jumps the pointer straight to the target, which arrives with
// no movement delta and so reads as a list scrolling under a still pointer. Two
// moves land the second one carrying a delta, as a real pointer does.
export async function hoverRow(page: Page, target: Locator) {
  const box = await target.boundingBox()
  if (!box) throw new Error("row has no box to hover")
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + 6, y)
  await page.mouse.move(box.x + Math.min(40, box.width - 6), y)
}

export async function openPalette(page: Page) {
  await defocus(page)
  await page.keyboard.press(`${modKey}+P`)

  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("textbox").first()).toBeVisible()
  return dialog
}

export async function closeDialog(page: Page, dialog: Locator) {
  await page.keyboard.press("Escape")
  const closed = await dialog
    .waitFor({ state: "detached", timeout: 1500 })
    .then(() => true)
    .catch(() => false)

  if (closed) return

  await page.keyboard.press("Escape")
  const closedSecond = await dialog
    .waitFor({ state: "detached", timeout: 1500 })
    .then(() => true)
    .catch(() => false)

  if (closedSecond) return

  await page.locator('[data-component="dialog-overlay"]').click({ position: { x: 5, y: 5 } })
  await expect(dialog).toHaveCount(0)
}

export async function isSidebarClosed(page: Page) {
  const main = page.locator("main")
  const classes = (await main.getAttribute("class")) ?? ""
  return classes.includes("expanded:border-l")
}

export async function toggleSidebar(page: Page) {
  await defocus(page)
  await page.keyboard.press(`${modKey}+B`)
}

export async function openSidebar(page: Page) {
  if (!(await isSidebarClosed(page))) return
  await toggleSidebar(page)
  await expect(page.locator("main")).not.toHaveClass(/expanded:border-l/)
}

export async function closeSidebar(page: Page) {
  if (await isSidebarClosed(page)) return
  await toggleSidebar(page)
  await expect(page.locator("main")).toHaveClass(/expanded:border-l/)
}

export async function openSettings(page: Page) {
  await defocus(page)

  const dialog = page.getByRole("dialog")
  await page.keyboard.press(`${modKey}+Comma`).catch(() => undefined)

  const opened = await dialog
    .waitFor({ state: "visible", timeout: 3000 })
    .then(() => true)
    .catch(() => false)

  if (opened) return dialog

  await page.getByRole("button", { name: "Settings" }).first().click()
  await expect(dialog).toBeVisible()
  return dialog
}

export async function createTestProject() {
  // realpath: macOS tmpdir is a symlink (/var → /private/var) and the server
  // keys projects by resolved path, so an unresolved path never matches the
  // sidebar's data-project attribute.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-e2e-project-")))

  await fs.writeFile(path.join(root, "README.md"), "# e2e\n")

  execSync("git init", { cwd: root, stdio: "ignore" })
  execSync("git add -A", { cwd: root, stdio: "ignore" })
  execSync('git -c user.name="e2e" -c user.email="e2e@example.com" commit -m "init" --allow-empty', {
    cwd: root,
    stdio: "ignore",
  })

  return root
}

export async function cleanupTestProject(directory: string) {
  await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)
}

export function sessionIDFromUrl(url: string) {
  const match = /\/session\/([^/?#]+)/.exec(url)
  return match?.[1]
}

export async function hoverSessionItem(page: Page, sessionID: string) {
  const sessionEl = page.locator(sessionItemSelector(sessionID)).first()
  await expect(sessionEl).toBeVisible()
  await sessionEl.hover()
  return sessionEl
}

export async function openSessionMoreMenu(page: Page, sessionID: string) {
  const menu = page.locator(dropdownMenuContentSelector).first()
  // The trigger only exists while the row is hovered, and under parallel-suite
  // load the hover can be stolen between the hover and the click, leaving a
  // menu that opened and instantly closed. Retry the dance as one unit.
  await expect(async () => {
    const sessionEl = await hoverSessionItem(page, sessionID)
    const menuTrigger = sessionEl.locator(dropdownMenuTriggerSelector).first()
    await expect(menuTrigger).toBeVisible({ timeout: 2_000 })
    await menuTrigger.click({ timeout: 2_000 })
    await expect(menu).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
  return menu
}

export async function clickMenuItem(menu: Locator, itemName: string | RegExp, options?: { force?: boolean }) {
  const item = menu.getByRole("menuitem").filter({ hasText: itemName }).first()
  await expect(item).toBeVisible()
  await item.click({ force: options?.force })
}

export async function confirmDialog(page: Page, buttonName: string | RegExp) {
  const dialog = page.getByRole("dialog").first()
  await expect(dialog).toBeVisible()

  const button = dialog.getByRole("button").filter({ hasText: buttonName }).first()
  await expect(button).toBeVisible()
  await button.click()
}

export async function clickPopoverButton(page: Page, buttonName: string | RegExp) {
  const button = page.getByRole("button").filter({ hasText: buttonName }).first()
  await expect(button).toBeVisible()
  await button.click()
}

export async function clickListItem(
  container: Locator | Page,
  filter: string | RegExp | { key?: string; text?: string | RegExp; keyStartsWith?: string },
): Promise<Locator> {
  let item: Locator

  if (typeof filter === "string" || filter instanceof RegExp) {
    item = container.locator(listItemSelector).filter({ hasText: filter }).first()
  } else if (filter.keyStartsWith) {
    item = container.locator(listItemKeyStartsWithSelector(filter.keyStartsWith)).first()
  } else if (filter.key) {
    item = container.locator(listItemKeySelector(filter.key)).first()
  } else if (filter.text) {
    item = container.locator(listItemSelector).filter({ hasText: filter.text }).first()
  } else {
    throw new Error("Invalid filter provided to clickListItem")
  }

  await expect(item).toBeVisible()
  await item.click()
  return item
}

export async function withSession<T>(
  sdk: ReturnType<typeof createSdk>,
  title: string,
  callback: (session: { id: string; title: string }) => Promise<T>,
): Promise<T> {
  const session = await sdk.session.create({ title }).then((r) => r.data)
  if (!session?.id) throw new Error("Session create did not return an id")

  try {
    return await callback(session)
  } finally {
    await sdk.session.delete({ sessionID: session.id }).catch(() => undefined)
  }
}

export async function openStatusPopover(page: Page) {
  await defocus(page)

  const rightSection = page.locator(titlebarRightSelector)
  // Scoped to the bar rather than one mount: which section holds the indicator
  // is a layout decision, and only one of the two branches is ever visible.
  const trigger = page
    .locator(titlebarSelector)
    .getByRole("button", { name: /status/i })
    .locator("visible=true")
    .first()

  const popoverBody = page.locator(popoverBodySelector).filter({ has: page.locator('[data-component="tabs"]') })

  const opened = await popoverBody
    .isVisible()
    .then((x) => x)
    .catch(() => false)

  if (!opened) {
    await expect(trigger).toBeVisible()
    await trigger.click()
    await expect(popoverBody).toBeVisible()
  }

  return { rightSection, popoverBody }
}

export async function openProjectMenu(page: Page, projectSlug: string) {
  const trigger = page.locator(projectMenuTriggerSelector(projectSlug)).first()
  await expect(trigger).toHaveCount(1)

  await trigger.focus()
  await page.keyboard.press("Enter")

  const menu = page.locator(dropdownMenuContentSelector).first()
  const opened = await menu
    .waitFor({ state: "visible", timeout: 1500 })
    .then(() => true)
    .catch(() => false)

  if (opened) {
    const viewport = page.viewportSize()
    const x = viewport ? Math.max(viewport.width - 5, 0) : 1200
    const y = viewport ? Math.max(viewport.height - 5, 0) : 800
    await page.mouse.move(x, y)
    return menu
  }

  await trigger.click({ force: true })

  await expect(menu).toBeVisible()

  const viewport = page.viewportSize()
  const x = viewport ? Math.max(viewport.width - 5, 0) : 1200
  const y = viewport ? Math.max(viewport.height - 5, 0) : 800
  await page.mouse.move(x, y)
  return menu
}
