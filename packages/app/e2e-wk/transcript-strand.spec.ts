import { test, expect } from "@playwright/test"

const live =
  "http://127.0.0.1:4097/L3BhdGgvdG8vcHJvamVjdA/session/ses_example"

// A mounted row is not a visible one. The transcript's scroll range is estimated
// from a per-turn hint that a real turn overruns several times over, so the tail
// the follow loop pins to can sit past where the measured content ends and the
// row it mounts is laid out above the visible box. Counting nodes reads that as
// healthy; the session shows nothing. Measured here against the engine iPadOS
// runs, where a long session reproduced it: 10 turns held, 1 mounted, 0 visible.
test.describe("iPad WebKit", () => {
  test("a turn is visible in the transcript box, and survives a hide cycle", async ({ page }) => {
    await page.goto(live, { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(7000)

    const read = () =>
      page.evaluate(() => {
        const scroller = document.querySelector(".session-scroller") as HTMLElement
        const box = scroller.getBoundingClientRect()
        const rows = Array.from(document.querySelectorAll("[data-message-id]"))
        return {
          turns: rows.length,
          showing: rows.filter((el) => {
            const rect = (el as HTMLElement).getBoundingClientRect()
            return rect.bottom > box.top && rect.top < box.bottom
          }).length,
        }
      })

    const onLoad = await read()
    expect(onLoad.showing, `no turn visible on load (${onLoad.turns} mounted)`).toBeGreaterThan(0)

    // Hiding and showing within one frame is coalesced away entirely, so the
    // list is left holding a measurement no observation will correct.
    await page.evaluate(async () => {
      const root = document.getElementById("root")!
      root.style.display = "none"
      void root.offsetHeight
      root.style.display = ""
      await new Promise((resolve) => setTimeout(resolve, 1200))
    })

    const afterCycle = await read()
    expect(afterCycle.showing, `no turn visible after a hide cycle (${afterCycle.turns} mounted)`).toBeGreaterThan(0)
  })
})
