import { test, expect } from "@playwright/test"

const live =
  "http://127.0.0.1:4097/L3BhdGgvdG8vcHJvamVjdA/session/ses_example"

test.describe("iPad WebKit", () => {
  test("transcript owns its scroll and the shell fits the viewport", async ({ page }) => {
    await page.goto(live, { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(6000)

    const layout = await page.evaluate(() => {
      const scroller = document.querySelector(".session-scroller") as HTMLElement
      const root = document.getElementById("root")!
      return {
        sizeClass: document.documentElement.dataset.sizeClass,
        viewportHeight: window.innerHeight,
        rootHeight: Math.round(root.getBoundingClientRect().height),
        rootPosition: getComputedStyle(root).position,
        docScrollRange: document.documentElement.scrollHeight - document.documentElement.clientHeight,
        scrollerScrollable: scroller ? scroller.scrollHeight - scroller.clientHeight > 4 : null,
        scrollerOverflowY: scroller ? getComputedStyle(scroller).overflowY : null,
      }
    })
    console.log("LAYOUT " + JSON.stringify(layout))

    // The shell must fit the viewport, and the transcript box must be the
    // scrolling element, in the engine iPadOS actually runs.
    expect(layout.rootHeight).toBeLessThanOrEqual(layout.viewportHeight + 2)
    expect(layout.scrollerScrollable).toBe(true)
    expect(layout.scrollerOverflowY).toBe("auto")

    // Gesture semantics (follow/unfollow) are app logic, pinned by the
    // Chromium e2e suite; the engine question here is whether the box has
    // scroll range the engine honors. Tail-follow re-pins programmatic
    // writes, so read the moved position synchronously.
    const moved = await page.evaluate(() => {
      const scroller = document.querySelector(".session-scroller") as HTMLElement
      const before = scroller.scrollTop
      scroller.scrollTop = before - 1200
      return { before, after: scroller.scrollTop }
    })
    console.log("SCROLL " + JSON.stringify(moved))
    expect(moved.after).toBeLessThan(moved.before)
  })

  test("the document carries the chrome-collapse scroll range and the root rides it", async ({ page }) => {
    await page.goto(live, { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(6000)

    const range = await page.evaluate(() => {
      const probe = document.createElement("div")
      probe.style.height = "100lvh"
      document.body.appendChild(probe)
      const lvh = probe.getBoundingClientRect().height
      probe.style.height = "100svh"
      const svh = probe.getBoundingClientRect().height
      probe.remove()
      return {
        lvhMinusSvh: Math.round(lvh - svh),
        docScrollRange: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      }
    })
    console.log("RANGE " + JSON.stringify(range))
    // The document's scroll range must be twice the browser's collapsible-
    // chrome measure (lvh - svh): the bar height itself plus the runway that
    // survives the viewport growing as the bar collapses. Zero wherever
    // chrome cannot collapse (headless, desktop, PWA). The nonzero case
    // needs a real device; headless proves the invariance half.
    expect(range.docScrollRange).toBe(Math.max(0, 2 * range.lvhMinusSvh))

    // Scrolling whatever range exists must move browser chrome only: the
    // sticky root pins the shell to the viewport.
    const pinned = await page.evaluate(async () => {
      document.body.style.minHeight = "150vh"
      window.scrollTo(0, 120)
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const titlebar = document.querySelector('[data-slot="titlebar"]')!.getBoundingClientRect().top
      const scrollY = window.scrollY
      document.body.style.minHeight = ""
      window.scrollTo(0, 0)
      return { titlebarTop: Math.round(titlebar), scrollY: Math.round(scrollY) }
    })
    console.log("PINNED " + JSON.stringify(pinned))
    expect(pinned.scrollY).toBeGreaterThan(0)
    expect(pinned.titlebarTop).toBeLessThanOrEqual(2)
  })
})

test.describe("desktop Chromium invariance", () => {
  test("no scroll range appears on a chrome-less viewport", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(live, { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(6000)
    const state = await page.evaluate(() => ({
      docScrollRange: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      scrollerScrollable:
        (document.querySelector(".session-scroller") as HTMLElement).scrollHeight -
          (document.querySelector(".session-scroller") as HTMLElement).clientHeight >
        4,
    }))
    console.log("DESKTOP " + JSON.stringify(state))
    expect(state.docScrollRange).toBe(0)
    expect(state.scrollerScrollable).toBe(true)
  })
})
