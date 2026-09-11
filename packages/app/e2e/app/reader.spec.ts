import type { Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import { defocus, openSidebar, withSession } from "../actions"
import { promptSelector, sessionItemSelector } from "../selectors"
import { modKey, type createSdk } from "../utils"

// Reader is the full-screen read: all chrome (the composer, both pinned headers,
// and the pill cluster) rides one reveal state. Entering shows it; from there a
// dead-space click or tap is the only thing that toggles it. Nothing on a timer.

const PHONE = { width: 430, height: 900 }
const DESKTOP = { width: 1500, height: 900 }

// The exit orb is addressed by what it does. A positional or class-based
// selector picks up whichever sibling the cluster gained last.
const readerPill = (page: Page) => page.getByRole("button", { name: /reader mode/i })
const dictateOrb = (page: Page) => page.getByRole("button", { name: /dictate/i })

const scroller = (page: Page) => page.locator(".session-scroller")
const composer = (page: Page) => page.locator('[data-slot="composer"]')

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

// A dead-space point in the transcript: the left gutter, clear of any turn box.
function deadPoint(box: { x: number; y: number; width: number; height: number }) {
  return { x: Math.round(box.x + 5), y: Math.round(box.y + box.height / 2) }
}

async function clickDeadSpace(page: Page) {
  const box = await scroller(page).boundingBox()
  if (!box) throw new Error("transcript scroller has no box")
  const point = deadPoint(box)
  await page.mouse.click(point.x, point.y)
  await settle(page)
}

async function enterReader(page: Page) {
  await readerPill(page).click()
  await settle(page)
}

async function newSession(page: Page) {
  await defocus(page)
  await page.keyboard.press(`${modKey}+Shift+S`)
  await expect(page).toHaveURL(/\/session$/)
  await settle(page)
}

async function openSession(page: Page, sessionID: string) {
  await openSidebar(page)
  const item = page.locator(sessionItemSelector(sessionID)).first()
  await expect(item).toBeVisible()
  await item.click()
  await expect(page).toHaveURL(new RegExp("/session/" + sessionID + "$"))
  await settle(page)
}

test.describe("reader mode on a touch device", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: PHONE })

  test("entering reader starts clean, and stays hidden without a timer", async ({ page, sdk, gotoSession }) => {
    await withSession(sdk, `reader entry ${Date.now()}`, async (session) => {
      await seedTurn(sdk, session.id)
      await gotoSession(session.id)

      await enterReader(page)
      await expect(composer(page)).toBeHidden()
      expect(await reclaimed(page), "the clean entry reclaims the composer space").toBe(true)

      // No timer either way: nothing reveals on its own after entry.
      await page.waitForTimeout(3500)
      await expect(composer(page)).toBeHidden()
    })
  })

  test("a tap on dead space toggles the chrome", async ({ page, sdk, gotoSession }) => {
    await withSession(sdk, `reader tap ${Date.now()}`, async (session) => {
      await seedTurn(sdk, session.id)
      await gotoSession(session.id)
      await enterReader(page)
      await expect(composer(page)).toBeHidden()

      await clickDeadSpace(page)
      await expect(composer(page)).toBeVisible()

      await clickDeadSpace(page)
      await expect(composer(page)).toBeHidden()
      expect(await reclaimed(page), "the hidden composer reclaims its space").toBe(true)
    })
  })

  test("a tap on a turn does its own thing and leaves the chrome alone", async ({ page, sdk, gotoSession }) => {
    await withSession(sdk, `reader tap turn ${Date.now()}`, async (session) => {
      await seedTurn(sdk, session.id)
      await gotoSession(session.id)
      await enterReader(page)
      // Reveal first, so a stray toggle from the turn tap would show up.
      await clickDeadSpace(page)
      await expect(composer(page)).toBeVisible()

      const turn = page.locator('[data-component="session-turn"]').first()
      await expect(turn).toBeVisible()
      await turn.click({ position: { x: 5, y: 5 } })
      await settle(page)
      await expect(composer(page)).toBeVisible()
    })
  })

  test("scrolling never toggles the chrome", async ({ page, sdk, gotoSession }) => {
    await withSession(sdk, `reader scroll ${Date.now()}`, async (session) => {
      await seedTurn(sdk, session.id)
      await gotoSession(session.id)
      await enterReader(page)
      await expect(composer(page)).toBeHidden()

      const box = await scroller(page).boundingBox()
      if (!box) throw new Error("transcript scroller has no box")
      const point = deadPoint(box)
      await page.mouse.move(point.x, point.y)
      await page.mouse.down()
      await page.mouse.move(point.x, point.y - 140, { steps: 10 })
      await page.mouse.up()
      await settle(page)
      await expect(composer(page)).toBeHidden()
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

  test("the hidden composer is inert, so it holds no focus and no tab stop", async ({ page, sdk, gotoSession }) => {
    await withSession(sdk, `reader inert ${Date.now()}`, async (session) => {
      await seedTurn(sdk, session.id)
      await gotoSession(session.id)

      const editor = page.locator(promptSelector)
      await editor.tap()
      await expect(editor).toBeFocused()

      await enterReader(page)

      // Reader starts clean, so the composer is hidden and inert right away. It
      // carries its own hidden/inert state rather than inheriting the dock's,
      // because a pending question keeps the dock on screen and the composer
      // must go anyway.
      await expect(composer(page)).toHaveAttribute("inert", "")
      await expect(composer(page)).toBeHidden()
      await expect(editor).not.toBeFocused()
    })
  })

  test("the cluster carries the exit and dictate orbs in a session", async ({ page, sdk, gotoSession }) => {
    await withSession(sdk, `reader orbs ${Date.now()}`, async (session) => {
      await seedTurn(sdk, session.id)
      await gotoSession(session.id)

      await enterReader(page)
      await clickDeadSpace(page)
      await expect(readerPill(page)).toBeVisible()
      await expect(dictateOrb(page)).toBeVisible()
    })
  })
})

// Reader hides the composer, and the new-session view is nothing but a
// composer, so carrying the mode into one leaves nothing to start a session
// from. Navigating in-app rather than by URL: a page load drops the mode on
// its own, which would pass whether or not the arrival resets anything.
test.describe("reader mode and a new session", () => {
  test.use({ viewport: DESKTOP })

  test("a new session starts outside reader, whatever the last one was left in", async ({
    page,
    sdk,
    gotoSession,
  }) => {
    await withSession(sdk, `reader new session ${Date.now()}`, async (session) => {
      await gotoSession(session.id)

      const docked = await clearance(page)
      await enterReader(page)
      expect(await reclaimed(page), "reader reclaims the composer space").toBe(true)

      await newSession(page)
      expect(await clearance(page), "the new session keeps its composer").toBe(docked)
      await expect(composer(page)).toBeVisible()
    })
  })

  test("reader on the new-session view belongs to it, not to the session opened next", async ({
    page,
    sdk,
    gotoSession,
  }) => {
    await withSession(sdk, `reader new inherit ${Date.now()}`, async (session) => {
      await gotoSession(session.id)
      const docked = await clearance(page)

      await newSession(page)
      await enterReader(page)
      expect(await reclaimed(page), "reader reclaims the composer space").toBe(true)

      await openSession(page, session.id)
      expect(await clearance(page), "the opened session keeps its composer").toBe(docked)
    })
  })
})

test.describe("reader mode on a fine pointer", () => {
  test.use({ viewport: DESKTOP })

  test("a dead-space click toggles the chrome, and it stays without a timer", async ({ page, sdk, gotoSession }) => {
    await withSession(sdk, `reader pointer ${Date.now()}`, async (session) => {
      await seedTurn(sdk, session.id)
      await gotoSession(session.id)

      const docked = await clearance(page)
      expect(docked).not.toBe("0px")

      await enterReader(page)
      await expect(composer(page)).toBeHidden()

      // No timer: it stays hidden until a deliberate click.
      await page.waitForTimeout(3500)
      await expect(composer(page)).toBeHidden()

      await clickDeadSpace(page)
      await expect(composer(page)).toBeVisible()

      await clickDeadSpace(page)
      await expect(composer(page)).toBeHidden()
    })
  })

  test("revealing on a fine pointer lands the caret in the composer", async ({ page, sdk, gotoSession }) => {
    await withSession(sdk, `reader focus ${Date.now()}`, async (session) => {
      await seedTurn(sdk, session.id)
      await gotoSession(session.id)
      await enterReader(page)
      await expect(composer(page)).toBeHidden()

      // Revealing on a mouse takes the caret so the reader can type at once.
      await clickDeadSpace(page)
      await expect(composer(page)).toBeVisible()
      await expect(page.locator(promptSelector)).toBeFocused()
    })
  })

  test("e reveals the hidden chrome and takes the caret", async ({ page, sdk, gotoSession }) => {
    await withSession(sdk, `reader e key ${Date.now()}`, async (session) => {
      await seedTurn(sdk, session.id)
      await gotoSession(session.id)
      await enterReader(page)

      const editor = page.locator(promptSelector)
      await expect(composer(page)).toBeHidden()

      // While hidden, "e" is the keyboard's reveal — same as a dead-space click.
      await page.keyboard.press("e")
      await expect(composer(page)).toBeVisible()
      await expect(editor).toBeFocused()
      await expect(editor).toHaveText("")

      // Once revealed and holding the caret, "e" is a character again.
      await page.keyboard.type("eee")
      await expect(editor).toHaveText("eee")
    })
  })

  test("submitting a message hides the chrome again", async ({ page, sdk, gotoSession }) => {
    await withSession(sdk, `reader submit ${Date.now()}`, async (session) => {
      await seedTurn(sdk, session.id)
      await gotoSession(session.id)
      await enterReader(page)

      // Reveal, type, and send: sending closes the type loop, so the chrome
      // falls back to the clean reading surface.
      const editor = page.locator(promptSelector)
      await clickDeadSpace(page)
      await expect(editor).toBeFocused()
      await page.keyboard.type("hello from reader")

      await page.keyboard.press("Enter")
      await expect(composer(page)).toBeHidden()
      expect(await reclaimed(page), "the sent composer reclaims its space").toBe(true)
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
