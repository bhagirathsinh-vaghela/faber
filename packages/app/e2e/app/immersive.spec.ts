import type { Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import { withSession } from "../actions"
import { promptSelector } from "../selectors"
import type { createSdk } from "../utils"

// Immersive reading hides the prompt dock and both pinned headers so a
// transcript can use the whole screen. Four independent gates guard the toggle
// (a coarse pointer, zen mode, no pending question, an unclaimed tap target),
// and the reclaim itself is a contract between a CSS variable and the five
// consumers that reserve space against it.

const PHONE = { width: 430, height: 900 }

const zenPill = (page: Page) => page.locator("button.fixed").first()

const scroller = (page: Page) => page.locator(".session-scroller")

// Asserting the reserved space rather than the dock's own box: the dock hides
// by transform and keeps its height either way, so its rect proves nothing
// about whether the transcript got the room back.
const clearance = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--prompt-height").trim())

const settle = (page: Page) => page.waitForTimeout(400)

// A rendered turn, which the pinned prompt bar and every sticky box inside a
// transcript need to exist at all. Shell is the one way to get one without
// spending a model call.
async function seedTurn(sdk: ReturnType<typeof createSdk>, sessionID: string) {
  await sdk.session.shell({ sessionID, agent: "build", command: "echo immersive" })
}

// A tap on transcript background rather than on any turn's content.
async function tapBackdrop(page: Page) {
  const box = await scroller(page).boundingBox()
  if (!box) throw new Error("transcript scroller has no box")
  await page.mouse.click(Math.round(box.x + 5), Math.round(box.y + box.height / 2))
  await settle(page)
}

async function enterZen(page: Page) {
  await zenPill(page).click()
  await settle(page)
}

test.describe("immersive reading", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: PHONE })

  test("a tap reclaims the dock's space and a second tap gives it back", async ({ page, sdk, gotoSession }) => {
    await withSession(sdk, `immersive clearance ${Date.now()}`, async (session) => {
      await gotoSession(session.id)
      await enterZen(page)

      const docked = await clearance(page)
      expect(docked).not.toBe("0px")

      await tapBackdrop(page)
      expect(await clearance(page)).toBe("0px")

      await tapBackdrop(page)
      expect(await clearance(page)).toBe(docked)
    })
  })

  test("the pinned title stops reserving space", async ({ page, sdk, gotoSession }) => {
    await withSession(sdk, `immersive headers ${Date.now()}`, async (session) => {
      await gotoSession(session.id)
      await enterZen(page)

      const pinned = await scroller(page).evaluate((el) =>
        getComputedStyle(el).getPropertyValue("--session-title-height").trim(),
      )
      expect(pinned).not.toBe("0px")

      await tapBackdrop(page)

      const released = await scroller(page).evaluate((el) =>
        getComputedStyle(el).getPropertyValue("--session-title-height").trim(),
      )
      expect(released).toBe("0px")
    })
  })

  test("a released prompt bar reserves no offset for the boxes below it", async ({ page, sdk, gotoSession }) => {
    await withSession(sdk, `immersive offsets ${Date.now()}`, async (session) => {
      await seedTurn(sdk, session.id)
      await gotoSession(session.id)

      const turn = page.locator('[data-component="session-turn"]').first()
      await expect(turn).toBeVisible()

      // Resolved through a probe rather than read as a string: the variable
      // holds an unevaluated calc(), so comparing its text would pass on a
      // calc() that still sums to a stale header height.
      const offset = () =>
        turn.evaluate((el) => {
          const probe = document.createElement("div")
          probe.style.position = "absolute"
          probe.style.top = "var(--sticky-header-height, 0px)"
          el.appendChild(probe)
          const top = getComputedStyle(probe).top
          probe.remove()
          return top
        })

      await enterZen(page)
      expect(await offset()).not.toBe("0px")

      await tapBackdrop(page)
      expect(await offset()).toBe("0px")
    })
  })

  test("the hidden dock is inert, so it holds no focus and no tab stop", async ({ page, sdk, gotoSession }) => {
    await withSession(sdk, `immersive inert ${Date.now()}`, async (session) => {
      await gotoSession(session.id)
      await enterZen(page)

      const editor = page.locator(promptSelector)
      await editor.tap()
      await expect(editor).toBeFocused()

      await tapBackdrop(page)

      await expect(page.locator('[data-slot="prompt-dock"]')).toHaveAttribute("inert", "")
      await expect(editor).not.toBeFocused()
    })
  })

  test("the zen pill stays on screen, so the mode is always escapable", async ({ page, sdk, gotoSession }) => {
    await withSession(sdk, `immersive escape ${Date.now()}`, async (session) => {
      await gotoSession(session.id)
      await enterZen(page)
      await tapBackdrop(page)

      const pill = zenPill(page)
      await expect(pill).toBeVisible()

      const box = await pill.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.y).toBeGreaterThanOrEqual(0)
      expect(box!.y + box!.height).toBeLessThanOrEqual(PHONE.height)
    })
  })

  test("a drag scrolls without toggling", async ({ page, sdk, gotoSession }) => {
    await withSession(sdk, `immersive drag ${Date.now()}`, async (session) => {
      await gotoSession(session.id)
      await enterZen(page)

      const before = await clearance(page)
      const box = await scroller(page).boundingBox()
      if (!box) throw new Error("transcript scroller has no box")

      const x = Math.round(box.x + 5)
      const y = Math.round(box.y + box.height / 2)
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x, y - 140, { steps: 10 })
      await page.mouse.up()
      await settle(page)

      expect(await clearance(page)).toBe(before)
    })
  })

  test("leaving zen restores the chrome", async ({ page, sdk, gotoSession }) => {
    await withSession(sdk, `immersive zen exit ${Date.now()}`, async (session) => {
      await gotoSession(session.id)
      await enterZen(page)

      const docked = await clearance(page)
      await tapBackdrop(page)
      expect(await clearance(page)).toBe("0px")

      await zenPill(page).click()
      await settle(page)
      expect(await clearance(page)).toBe(docked)
    })
  })

  test("a tap outside zen does nothing", async ({ page, sdk, gotoSession }) => {
    await withSession(sdk, `immersive zen gate ${Date.now()}`, async (session) => {
      await gotoSession(session.id)

      const before = await clearance(page)
      await tapBackdrop(page)
      expect(await clearance(page)).toBe(before)
    })
  })
})

test.describe("immersive reading on a fine pointer", () => {
  test.use({ viewport: PHONE })

  test("a click never toggles, because it already places the caret", async ({ page, sdk, gotoSession }) => {
    await withSession(sdk, `immersive pointer ${Date.now()}`, async (session) => {
      await gotoSession(session.id)
      await enterZen(page)

      const before = await clearance(page)
      await tapBackdrop(page)
      expect(await clearance(page)).toBe(before)
    })
  })
})
