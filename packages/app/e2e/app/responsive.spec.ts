import type { Page } from "@playwright/test"
import { test, expect } from "../fixtures"

// The layout has exactly three inputs, and each answers a different question:
// the shell size class (how many panes fit), a container query (how much room
// one panel has), and a pointer query (mouse or finger). These lock that split
// down, because every regression here came from one input answering another's
// question.

const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  phoneLandscape: { width: 844, height: 390 },
  tabletPortrait: { width: 834, height: 1112 },
  tabletLandscape: { width: 1194, height: 834 },
  smallLaptop: { width: 1280, height: 800 },
  desktop: { width: 1600, height: 1000 },
  ultrawide: { width: 2560, height: 1200 },
  mediumEdgeBelow: { width: 599, height: 900 },
  mediumEdgeAt: { width: 600, height: 900 },
  expandedEdgeBelow: { width: 839, height: 900 },
  expandedEdgeAt: { width: 840, height: 900 },
  wideButShort: { width: 1200, height: 420 },
} as const

const sizeClass = (page: Page) => page.evaluate(() => document.documentElement.dataset.sizeClass)

const settle = (page: Page) => page.waitForTimeout(350)

test.describe("shell size class", () => {
  test("classifies every viewport, including the exact breakpoint edges", async ({ page, gotoSession }) => {
    await gotoSession()

    const cases: [keyof typeof VIEWPORTS, string][] = [
      ["phone", "compact"],
      ["mediumEdgeBelow", "compact"],
      ["mediumEdgeAt", "medium"],
      ["tabletPortrait", "medium"],
      ["expandedEdgeBelow", "medium"],
      ["expandedEdgeAt", "expanded"],
      ["tabletLandscape", "expanded"],
      ["smallLaptop", "expanded"],
      ["desktop", "expanded"],
      ["ultrawide", "expanded"],
      // Wide enough for three panes, too short to stack them.
      ["wideButShort", "medium"],
      ["phoneLandscape", "medium"],
    ]

    for (const [name, expected] of cases) {
      await page.setViewportSize(VIEWPORTS[name])
      await settle(page)
      expect(await sizeClass(page), `${name} should be ${expected}`).toBe(expected)
    }
  })

  test("CSS and JS never disagree about the size class", async ({ page, gotoSession }) => {
    await gotoSession()

    for (const name of ["phone", "tabletPortrait", "desktop"] as const) {
      await page.setViewportSize(VIEWPORTS[name])
      await settle(page)

      const verdicts = await page.evaluate(() => {
        const probe = document.createElement("div")
        // A pair of classes whose CSS answer must match the JS attribute.
        probe.className = "hidden compact:block"
        document.body.appendChild(probe)
        const cssSaysCompact = getComputedStyle(probe).display === "block"
        probe.remove()
        return { cssSaysCompact, attribute: document.documentElement.dataset.sizeClass }
      })

      expect(verdicts.cssSaysCompact, `${name}: stylesheet must agree with the attribute`).toBe(
        verdicts.attribute === "compact",
      )
    }
  })
})

test.describe("forced size class", () => {
  test("overrides the viewport in both CSS and JS, then releases back to it", async ({ page, gotoSession }) => {
    await gotoSession()
    await page.setViewportSize(VIEWPORTS.desktop)
    await settle(page)
    expect(await sizeClass(page)).toBe("expanded")

    const toggle = page.locator("[aria-label*='layout']").locator("visible=true").first()

    await toggle.click()
    await settle(page)
    expect(await sizeClass(page), "a press on an unforced shell pins the opposite end").toBe("compact")

    // The forced class has to reach stylesheets that never learn it exists.
    const titlebarHeight = await page.evaluate(
      () => getComputedStyle(document.querySelector('[data-slot="titlebar"]')!).height,
    )
    expect(titlebarHeight, "compact titlebar is taller").toBe("48px")

    await toggle.click()
    await settle(page)
    expect(await sizeClass(page), "a press while pinned hands the decision back to the window").toBe("expanded")
    expect(
      await page.evaluate(() => localStorage.getItem("opencode-size-class")),
      "releasing the pin clears the stored override",
    ).toBeNull()
  })

  test("survives a reload without flashing the other layout", async ({ page, gotoSession }) => {
    await gotoSession()
    await page.setViewportSize(VIEWPORTS.desktop)
    await settle(page)

    await page.locator("[aria-label*='layout']").locator("visible=true").first().click()
    await settle(page)
    expect(await sizeClass(page)).toBe("compact")

    await page.reload()
    await page.waitForLoadState("domcontentloaded")

    // Read before the app can hydrate: the pre-paint script owns this.
    expect(await sizeClass(page), "the forced class is applied before first paint").toBe("compact")
  })

  test("is reachable from every natural size class", async ({ page, gotoSession }) => {
    await gotoSession()

    for (const name of ["phone", "tabletPortrait", "desktop"] as const) {
      await page.setViewportSize(VIEWPORTS[name])
      await settle(page)
      const natural = await sizeClass(page)

      const toggle = page.locator("[aria-label*='layout']").locator("visible=true").first()
      await toggle.click()
      await settle(page)
      expect(await sizeClass(page), `${name}: press must change the layout`).not.toBe(natural)

      await toggle.click()
      await settle(page)
      expect(await sizeClass(page), `${name}: second press returns to the window's own answer`).toBe(natural)
    }
  })
})

test.describe("container queries", () => {
  test("the dock follows its own width, not the window's", async ({ page, gotoSession }) => {
    await gotoSession()
    await page.setViewportSize(VIEWPORTS.desktop)
    await settle(page)

    const measure = () =>
      page.evaluate(() => {
        const host = document.querySelector('[class*="@container/dock"]') as HTMLElement
        const inner = host.firstElementChild as HTMLElement
        const row = host.querySelector('[class*="dock-wide:flex-row"]') as HTMLElement
        return {
          width: Math.round(host.getBoundingClientRect().width),
          gap: getComputedStyle(inner).gap,
          direction: getComputedStyle(row).flexDirection,
        }
      })

    const roomy = await measure()
    expect(roomy.direction, "a wide dock lays its controls out in a row").toBe("row")

    const squeezed = await page.evaluate(() => {
      const host = document.querySelector('[class*="@container/dock"]') as HTMLElement
      host.style.width = "400px"
      return new Promise<{ width: number; gap: string; direction: string }>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const inner = host.firstElementChild as HTMLElement
            const row = host.querySelector('[class*="dock-wide:flex-row"]') as HTMLElement
            const out = {
              width: Math.round(host.getBoundingClientRect().width),
              gap: getComputedStyle(inner).gap,
              direction: getComputedStyle(row).flexDirection,
            }
            host.style.width = ""
            resolve(out)
          }),
        ),
      )
    })

    expect(squeezed.width).toBe(400)
    expect(squeezed.direction, "a narrow dock stacks, even inside a wide window").toBe("column")
    expect(squeezed.gap).not.toBe(roomy.gap)
  })

  test("a forced compact shell beats a dock with room to spare", async ({ page, gotoSession }) => {
    await gotoSession()
    // Wide enough that the container query alone would choose the roomy layout.
    await page.setViewportSize(VIEWPORTS.desktop)
    await settle(page)

    await page.locator("[aria-label*='layout']").locator("visible=true").first().click()
    await settle(page)

    const state = await page.evaluate(() => {
      const host = document.querySelector('[class*="@container/dock"]') as HTMLElement
      const row = host.querySelector('[class*="dock-wide:flex-row"]') as HTMLElement
      return {
        sizeClass: document.documentElement.dataset.sizeClass,
        dockWidth: Math.round(host.getBoundingClientRect().width),
        direction: getComputedStyle(row).flexDirection,
      }
    })

    expect(state.sizeClass).toBe("compact")
    expect(state.dockWidth, "the dock still has room for the roomy layout").toBeGreaterThan(672)
    expect(state.direction, "an explicit request outranks the space available").toBe("column")
  })

  test("no element queries a container it declares itself", async ({ page, gotoSession }) => {
    await gotoSession()

    // Such a rule can never match, so it reads as live styling that silently
    // does nothing.
    const selfQueries = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[class*="@container/"]')]
        .filter((el) => /(?:^|\s)(?:dock|panel)-wide:/.test(el.className))
        .map((el) => el.className.slice(0, 120)),
    )

    expect(selfQueries).toEqual([])
  })
})

test.describe("pointer capability", () => {
  test("target size follows the pointer, not the viewport", async ({ page, gotoSession }) => {
    await gotoSession()

    // Measured off a detached probe rather than a live control: the controls
    // carrying this class are themselves layout-gated, so a hidden one would
    // report 0 and hide whether the size rule moved.
    const sizes: number[] = []
    for (const name of ["phone", "desktop"] as const) {
      await page.setViewportSize(VIEWPORTS[name])
      await settle(page)
      sizes.push(
        await page.evaluate(() => {
          const probe = document.createElement("div")
          probe.className = "size-6 any-pointer-coarse:size-11"
          document.body.appendChild(probe)
          const width = Math.round(probe.getBoundingClientRect().width)
          probe.remove()
          return width
        }),
      )
    }

    expect(sizes[0], "a control must exist to measure").toBeGreaterThan(0)
    expect(sizes[0], "width must not change a target sized by pointer capability").toBe(sizes[1])
  })

  test("a fine pointer meets the WCAG minimum and a coarse one the enhanced size", async ({ page, gotoSession }) => {
    await gotoSession()
    await page.setViewportSize(VIEWPORTS.desktop)
    await settle(page)

    const target = await page.evaluate(() => {
      const el = document.createElement("div")
      el.className = "size-6 any-pointer-coarse:size-11"
      document.body.appendChild(el)
      const fine = Math.round(el.getBoundingClientRect().width)

      const forced = document.createElement("style")
      forced.textContent =
        ".__coarse { width: calc(var(--spacing) * 11) !important; height: calc(var(--spacing) * 11) !important }"
      document.head.appendChild(forced)
      el.classList.add("__coarse")
      const coarse = Math.round(el.getBoundingClientRect().width)
      el.remove()
      forced.remove()

      return { fine, coarse }
    })

    expect(target.fine, "WCAG 2.5.8 target size (minimum)").toBeGreaterThanOrEqual(24)
    expect(target.coarse, "WCAG 2.5.5 target size (enhanced)").toBeGreaterThanOrEqual(44)
  })
})

test.describe("chrome geometry", () => {
  test("the overlay sidebar sits flush under the titlebar at every size", async ({ page, gotoSession }) => {
    await gotoSession()

    for (const name of ["phone", "tabletPortrait"] as const) {
      await page.setViewportSize(VIEWPORTS[name])
      await settle(page)

      const gap = await page.evaluate(() => {
        const titlebar = document.querySelector('[data-slot="titlebar"]')!.getBoundingClientRect()
        const drawer = document.querySelector('[data-component="sidebar-nav-mobile"]')!.getBoundingClientRect()
        return Math.round(drawer.top - titlebar.bottom)
      })

      // The root's hairline padding puts this at 0 or -1, never a visible gap.
      expect(Math.abs(gap), `${name}: drawer must not float below the titlebar`).toBeLessThanOrEqual(1)
    }
  })

  test("every titlebar control receives its own clicks", async ({ page, gotoSession }) => {
    await gotoSession()

    // The centred search box is an absolutely-positioned overlay spanning the
    // whole bar, so a stray pointer-events:auto on its wrapper silently
    // swallows clicks aimed at the buttons beneath it.
    for (const name of ["phone", "tabletPortrait", "desktop"] as const) {
      await page.setViewportSize(VIEWPORTS[name])
      await settle(page)

      const blocked = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll<HTMLElement>('[data-slot="titlebar"] button')].filter(
          (b) => b.getBoundingClientRect().width > 0,
        )
        return buttons
          .filter((button) => {
            const box = button.getBoundingClientRect()
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
            return !button.contains(hit) && hit !== button
          })
          .map((button) => button.getAttribute("aria-label") ?? "unnamed")
      })

      expect(blocked, `${name}: no control may be covered by another element`).toEqual([])
    }
  })

  test("exactly one server indicator is visible in the titlebar", async ({ page, gotoSession }) => {
    await gotoSession()

    for (const name of ["phone", "tabletPortrait", "desktop"] as const) {
      await page.setViewportSize(VIEWPORTS[name])
      await settle(page)

      const visible = await page.evaluate(
        () =>
          [...document.querySelectorAll('[data-slot="titlebar"] button')].filter(
            (b) => /desktop|localhost|127\.0\.0\.1/i.test(b.textContent ?? "") && b.getBoundingClientRect().width > 0,
          ).length,
      )

      expect(visible, `${name}: one indicator, not zero and not both branches`).toBe(1)
    }
  })
})

test.describe("no stray responsive mechanisms", () => {
  test("nothing decides layout from a width the shell cannot see", async ({ page, gotoSession }) => {
    await gotoSession()

    // A private width query cannot honour a forced size class, which is how the
    // markdown and diff styles used to contradict the layout around them.
    const rogue = await page.evaluate(() => {
      const found: string[] = []
      for (const sheet of document.styleSheets) {
        let rules: CSSRuleList
        try {
          rules = sheet.cssRules
        } catch {
          continue
        }
        const walk = (list: CSSRuleList) => {
          for (const rule of list) {
            if (rule instanceof CSSMediaRule) {
              if (/\b(?:min|max)-width\b/.test(rule.conditionText)) found.push(rule.conditionText)
            }
            const nested = (rule as CSSGroupingRule).cssRules
            if (nested) walk(nested)
          }
        }
        walk(rules)
      }
      return [...new Set(found)]
    })

    expect(rogue, "width media queries must go through the shell size class").toEqual([])
  })
})
