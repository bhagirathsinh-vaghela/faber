import type { Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import { withSession } from "../actions"
import { promptSelector } from "../selectors"
import type { createSdk } from "../utils"

// Reader is the full-screen read: the composer and both pinned headers go, and
// the pill is the only way in or out. The reclaim is a contract between a CSS
// variable and the five consumers that reserve space against it.

const PHONE = { width: 430, height: 900 }
const DESKTOP = { width: 1500, height: 900 }

const readerPill = (page: Page) => page.locator("button.fixed").first()

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
  await sdk.session.shell({ sessionID, agent: "build", command: "echo reader" })
}

async function tapBackdrop(page: Page) {
  const box = await scroller(page).boundingBox()
  if (!box) throw new Error("transcript scroller has no box")
  await page.mouse.click(Math.round(box.x + 5), Math.round(box.y + box.height / 2))
  await settle(page)
}

async function enterReader(page: Page) {
  await readerPill(page).click()
  await settle(page)
}

test.describe("reader mode", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: PHONE })

  test("the pill reclaims the composer's space, and taking it out gives it back", async ({
    page,
    sdk,
    gotoSession,
  }) => {
    await withSession(sdk, `reader clearance ${Date.now()}`, async (session) => {
      await gotoSession(session.id)

      const docked = await clearance(page)
      expect(docked).not.toBe("0px")

      await enterReader(page)
      expect(await clearance(page)).toBe("0px")

      await readerPill(page).click()
      await settle(page)
      expect(await clearance(page)).toBe(docked)
    })
  })

  test("nothing but the pill changes the mode", async ({ page, sdk, gotoSession }) => {
    await withSession(sdk, `reader gestures ${Date.now()}`, async (session) => {
      await seedTurn(sdk, session.id)
      await gotoSession(session.id)
      await enterReader(page)
      expect(await clearance(page)).toBe("0px")

      await tapBackdrop(page)
      expect(await clearance(page)).toBe("0px")

      const box = await scroller(page).boundingBox()
      if (!box) throw new Error("transcript scroller has no box")
      const x = Math.round(box.x + 5)
      const y = Math.round(box.y + box.height / 2)
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x, y - 140, { steps: 10 })
      await page.mouse.up()
      await settle(page)
      expect(await clearance(page)).toBe("0px")

      const turn = page.locator('[data-component="session-turn"]').first()
      await expect(turn).toBeVisible()
      await turn.click({ position: { x: 5, y: 5 } })
      await settle(page)
      expect(await clearance(page)).toBe("0px")
    })
  })

  test("the pinned title stops reserving space", async ({ page, sdk, gotoSession }) => {
    await withSession(sdk, `reader headers ${Date.now()}`, async (session) => {
      await gotoSession(session.id)

      const pinned = await scroller(page).evaluate((el) =>
        getComputedStyle(el).getPropertyValue("--session-title-height").trim(),
      )
      expect(pinned).not.toBe("0px")

      await enterReader(page)

      const released = await scroller(page).evaluate((el) =>
        getComputedStyle(el).getPropertyValue("--session-title-height").trim(),
      )
      expect(released).toBe("0px")
    })
  })

  test("a released prompt bar reserves no offset for the boxes below it", async ({ page, sdk, gotoSession }) => {
    await withSession(sdk, `reader offsets ${Date.now()}`, async (session) => {
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

      expect(await offset()).not.toBe("0px")

      await enterReader(page)
      expect(await offset()).toBe("0px")
    })
  })

  test("the hidden composer is inert, so it holds no focus and no tab stop", async ({ page, sdk, gotoSession }) => {
    await withSession(sdk, `reader inert ${Date.now()}`, async (session) => {
      await gotoSession(session.id)

      const editor = page.locator(promptSelector)
      await editor.tap()
      await expect(editor).toBeFocused()

      await enterReader(page)

      // The composer carries its own hidden/inert state rather than inheriting
      // the dock's, because a pending question keeps the dock on screen and the
      // composer must go anyway.
      const composer = page.locator('[data-slot="composer"]')
      await expect(composer).toHaveAttribute("inert", "")
      await expect(composer).toBeHidden()
      await expect(page.locator('[data-slot="prompt-dock"]')).toHaveAttribute("inert", "")
      await expect(editor).not.toBeFocused()
    })
  })

  test("the pill stays on screen, so the mode is always escapable", async ({ page, sdk, gotoSession }) => {
    await withSession(sdk, `reader escape ${Date.now()}`, async (session) => {
      await gotoSession(session.id)
      await enterReader(page)

      const pill = readerPill(page)
      await expect(pill).toBeVisible()

      const box = await pill.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.y).toBeGreaterThanOrEqual(0)
      expect(box!.y + box!.height).toBeLessThanOrEqual(PHONE.height)
    })
  })
})

// The mode is a declaration that the user is not interacting, which a mouse
// makes as readily as a finger. Pointer type earns no branch.
test.describe("reader mode on a fine pointer", () => {
  test.use({ viewport: DESKTOP })

  test("a mouse gets the same reclaim a finger does", async ({ page, sdk, gotoSession }) => {
    await withSession(sdk, `reader pointer ${Date.now()}`, async (session) => {
      await gotoSession(session.id)

      const docked = await clearance(page)
      expect(docked).not.toBe("0px")

      await enterReader(page)
      expect(await clearance(page)).toBe("0px")
      await expect(page.locator('[data-slot="prompt-dock"]')).toHaveAttribute("inert", "")
      await expect(page.locator('[data-slot="composer"]')).toBeHidden()
    })
  })

  test("the pill is draggable, and the parked position survives a mode toggle", async ({ page, sdk, gotoSession }) => {
    await withSession(sdk, `reader drag ${Date.now()}`, async (session) => {
      await gotoSession(session.id)

      const pill = readerPill(page)
      const start = await pill.boundingBox()
      if (!start) throw new Error("pill has no box")

      await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
      await page.mouse.down()
      await page.mouse.move(start.x + 40, start.y - 220, { steps: 12 })
      await page.mouse.up()
      await settle(page)

      const parked = await pill.boundingBox()
      if (!parked) throw new Error("pill has no box after drag")
      expect(Math.abs(parked.y - start.y)).toBeGreaterThan(100)

      // Moving the control and activating it are the two things the gesture
      // must keep apart, so a drag past the slop cannot also toggle.
      expect(await clearance(page)).not.toBe("0px")

      await enterReader(page)
      const afterToggle = await pill.boundingBox()
      if (!afterToggle) throw new Error("pill has no box in reader")
      expect(Math.round(afterToggle.y)).toBe(Math.round(parked.y))
    })
  })
})
