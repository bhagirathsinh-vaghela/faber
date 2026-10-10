import { test, expect } from "../fixtures"
import { openSidebar, openSessionMoreMenu, clickMenuItem, confirmDialog, withSession } from "../actions"
import { sessionItemSelector, inlineInputSelector } from "../selectors"

test("sidebar session can be renamed", async ({ page, sdk, gotoSession }) => {
  const stamp = Date.now()
  const originalTitle = `e2e rename test ${stamp}`
  const newTitle = `e2e renamed ${stamp}`

  await withSession(sdk, originalTitle, async (session) => {
    await gotoSession(session.id)
    await openSidebar(page)

    const menu = await openSessionMoreMenu(page, session.id)
    await clickMenuItem(menu, /rename/i)

    const input = page.locator(sessionItemSelector(session.id)).locator(inlineInputSelector).first()
    await expect(input).toBeVisible()
    await input.fill(newTitle)
    await input.press("Enter")

    await expect(page.locator(sessionItemSelector(session.id)).locator("a").first()).toContainText(newTitle)
  })
})

test("sidebar session can be archived", async ({ page, sdk, gotoSession }) => {
  const stamp = Date.now()
  const title = `e2e archive test ${stamp}`

  await withSession(sdk, title, async (session) => {
    await gotoSession(session.id)
    await openSidebar(page)

    const sessionEl = page.locator(sessionItemSelector(session.id))
    const menu = await openSessionMoreMenu(page, session.id)
    await clickMenuItem(menu, /archive/i)

    await expect(sessionEl).not.toBeVisible()
  })
})

test("sidebar session can be deleted", async ({ page, sdk, gotoSession }) => {
  const stamp = Date.now()
  const title = `e2e delete test ${stamp}`

  await withSession(sdk, title, async (session) => {
    await gotoSession(session.id)
    await openSidebar(page)

    const sessionEl = page.locator(sessionItemSelector(session.id))
    const menu = await openSessionMoreMenu(page, session.id)
    await clickMenuItem(menu, /delete/i)
    await confirmDialog(page, /delete/i)

    await expect(sessionEl).not.toBeVisible()
  })
})
