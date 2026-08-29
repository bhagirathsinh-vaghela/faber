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

// The mode toggle sits at the foot of a cluster that also holds compose and
// dictate, so it is addressed by what it does. A positional or class-based
// selector picks up whichever sibling the cluster gained last.
const readerPill = (page: Page) => page.getByRole("button", { name: /reader mode/i })

const scroller = (page: Page) => page.locator(".session-scroller")

// Asserting the reserved space rather than the dock's own box: the dock hides
// by transform and keeps its height either way, so its rect proves nothing
// about whether the transcript got the room back.
const clearance = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--prompt-height").trim())

// Reclaimed means the composer's own height is gone. A small constant gap
// remains so the transcript's last box never runs into the window's edge, so
// the assertion is a threshold rather than an exact zero.
const RECLAIMED = 16
const reclaimed = async (page: Page) => parseFloat(await clearance(page)) <= RECLAIMED

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
      expect(await reclaimed(page), "reader reclaims the composer space").toBe(true)

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
      expect(await reclaimed(page), "reader reclaims the composer space").toBe(true)

      await tapBackdrop(page)
      expect(await reclaimed(page), "reader reclaims the composer space").toBe(true)

      const box = await scroller(page).boundingBox()
      if (!box) throw new Error("transcript scroller has no box")
      const x = Math.round(box.x + 5)
      const y = Math.round(box.y + box.height / 2)
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x, y - 140, { steps: 10 })
      await page.mouse.up()
      await settle(page)
      expect(await reclaimed(page), "reader reclaims the composer space").toBe(true)

      const turn = page.locator('[data-component="session-turn"]').first()
      await expect(turn).toBeVisible()
      await turn.click({ position: { x: 5, y: 5 } })
      await settle(page)
      expect(await reclaimed(page), "reader reclaims the composer space").toBe(true)
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
      expect(await reclaimed(page), "reader reclaims the composer space").toBe(true)
      await expect(page.locator('[data-slot="composer"]')).toBeHidden()
    })
  })

  // Fine-pointer only: a mobile browser refuses programmatic focus of a
  // contenteditable, since it would raise the keyboard unasked. Verified with a
  // bare editor.focus() under mobile emulation, which is also refused.
  test("leaving reader puts the caret in the composer, wherever it was", async ({ page, sdk, gotoSession }) => {
    await withSession(sdk, `reader focus ${Date.now()}`, async (session) => {
      await seedTurn(sdk, session.id)
      await gotoSession(session.id)

      const editor = page.locator(promptSelector)
      await enterReader(page)
      await expect(editor).not.toBeFocused()

      // Park focus off the composer, so the exit has something to move rather
      // than something to leave alone.
      await scroller(page).click({ position: { x: 5, y: 60 } })
      await settle(page)
      await expect(editor).not.toBeFocused()

      await readerPill(page).click()
      await settle(page)
      await expect(editor).toBeFocused()
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
      expect(await reclaimed(page), "the composer holds its space").toBe(false)

      await enterReader(page)
      const afterToggle = await pill.boundingBox()
      if (!afterToggle) throw new Error("pill has no box in reader")
      expect(Math.round(afterToggle.y)).toBe(Math.round(parked.y))
    })
  })

  // A shrunken viewport is temporary, so the bounds it imposes are a matter of
  // what is drawn, and the parked position outlives them. The soft keyboard is
  // the case that reaches this: it takes the lower part of the viewport for as
  // long as it is up, and a pill parked there must be reachable meanwhile and
  // back in place afterward.
  test("a viewport shrinking under the pill lends it space rather than taking it", async ({
    page,
    sdk,
    gotoSession,
  }) => {
    await withSession(sdk, `reader keyboard ${Date.now()}`, async (session) => {
      await gotoSession(session.id)

      const pill = readerPill(page)
      const start = await pill.boundingBox()
      if (!start) throw new Error("pill has no box")

      // Park it in the lower band, which is the room a keyboard claims.
      await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
      await page.mouse.down()
      await page.mouse.move(start.x + start.width / 2, DESKTOP.height - 60, { steps: 12 })
      await page.mouse.up()
      await settle(page)

      const parked = await pill.boundingBox()
      if (!parked) throw new Error("pill has no box after drag")

      const shrunk = Math.round(DESKTOP.height * 0.6)
      await page.setViewportSize({ width: DESKTOP.width, height: shrunk })
      await settle(page)

      const lifted = await pill.boundingBox()
      if (!lifted) throw new Error("pill has no box in the shrunken viewport")
      expect(lifted.y, "the pill stays reachable above the keyboard").toBeGreaterThanOrEqual(0)
      expect(lifted.y + lifted.height, "the pill stays reachable above the keyboard").toBeLessThanOrEqual(shrunk)

      await page.setViewportSize(DESKTOP)
      await settle(page)

      const returned = await pill.boundingBox()
      if (!returned) throw new Error("pill has no box after the viewport returns")
      expect(Math.round(returned.y)).toBe(Math.round(parked.y))
      expect(Math.round(returned.x)).toBe(Math.round(parked.x))
    })
  })
})
