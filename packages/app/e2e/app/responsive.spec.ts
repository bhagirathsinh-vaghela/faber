import type { Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import { withSession } from "../actions"

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

// The size every chrome control grows to on a coarse pointer (`size-10`).
const COARSE_TARGET = 40

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
    // No control's SIZE branches on the size class, so only a topology rule can
    // witness this; a measured height answers the same at every class.
    const cssSaysCompact = await page.evaluate(() => {
      const probe = document.createElement("div")
      probe.className = "hidden compact:block"
      document.body.appendChild(probe)
      const verdict = getComputedStyle(probe).display === "block"
      probe.remove()
      return verdict
    })
    expect(cssSaysCompact, "a forced class must reach the stylesheet, not just the attribute").toBe(true)

    await toggle.click()
    await settle(page)
    expect(await sizeClass(page), "a press while pinned hands the decision back to the window").toBe("expanded")
    expect(
      await page.evaluate(() => sessionStorage.getItem("opencode-size-class")),
      "releasing the pin clears the stored override",
    ).toBeNull()
  })

  test("a pinned layout belongs to its tab alone", async ({ page, context, gotoSession }) => {
    await gotoSession()
    await page.setViewportSize(VIEWPORTS.desktop)
    await settle(page)

    await page.locator("[aria-label*='layout']").locator("visible=true").first().click()
    await settle(page)
    expect(await sizeClass(page)).toBe("compact")

    // Every client decides its own view: a second tab on the same server must
    // come up with the window's answer, not the first tab's pin.
    const second = await context.newPage()
    await second.setViewportSize(VIEWPORTS.desktop)
    await second.goto(page.url())
    await second.waitForLoadState("domcontentloaded")
    expect(
      await second.evaluate(() => document.documentElement.dataset.sizeClass),
      "a new tab must not inherit another tab's pin",
    ).toBe("expanded")
    await second.close()
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

  test("both ends and auto are reachable from every natural size class", async ({ page, gotoSession }) => {
    await gotoSession()

    for (const name of ["phone", "tabletPortrait", "desktop"] as const) {
      await page.setViewportSize(VIEWPORTS[name])
      await settle(page)
      const natural = await sizeClass(page)

      const toggle = () => page.locator("[aria-label*='layout']").locator("visible=true").first()

      const seen = new Set<string>()
      for (let press = 0; press < 3; press++) {
        await toggle().click()
        await settle(page)
        const forced = await page.evaluate(() => sessionStorage.getItem("opencode-size-class"))
        if (!forced) break
        seen.add(forced)
      }

      for (const end of ["compact", "expanded"]) {
        if (end === natural) continue
        expect(seen.has(end), `${name}: the cycle must reach ${end}`).toBe(true)
      }
      expect(await sizeClass(page), `${name}: the cycle must end back at the window's own answer`).toBe(natural)
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

  test("every chrome control grows for a finger, in both layouts", async ({ page, gotoSession }) => {
    await gotoSession()

    // A tablet renders the roomy chrome AND is touched, so the two layouts
    // cannot each assume an input: sizing the wide one for a mouse alone left
    // 24px targets under a finger.
    for (const name of ["phone", "tabletLandscape"] as const) {
      await page.setViewportSize(VIEWPORTS[name])
      await settle(page)

      const small = await page.evaluate(() => {
        // The pointer type cannot be emulated per-page, so the coarse rules are
        // lifted out of the stylesheet and re-applied unconditionally. Measuring
        // the result asks what the control BECOMES under a finger, which a check
        // for a particular class cannot: the size may arrive from a shared
        // custom property that names no pointer at all.
        const coarse: string[] = []
        const walk = (list: CSSRuleList) => {
          for (const rule of list) {
            if ((rule as CSSMediaRule).conditionText === "(any-pointer: coarse)") {
              for (const inner of (rule as CSSMediaRule).cssRules) coarse.push(inner.cssText)
              continue
            }
            const nested = (rule as CSSGroupingRule).cssRules
            if (nested) walk(nested)
          }
        }
        for (const sheet of document.styleSheets) {
          try {
            walk(sheet.cssRules)
          } catch {}
        }
        const patch = document.createElement("style")
        patch.textContent = coarse.join("\n")
        document.head.appendChild(patch)

        const measured = [...document.querySelectorAll<HTMLElement>('[data-slot="titlebar"] button')]
          .filter((button) => button.getBoundingClientRect().width > 0)
          .filter((button) => {
            const box = button.getBoundingClientRect()
            // A control wider than it is tall carries text or an input, so its
            // width is set by content rather than by the touch target.
            return box.height < 40 || (box.width < 40 && box.width >= box.height)
          })
          .map((button) => button.getAttribute("aria-label") ?? "unnamed")

        patch.remove()
        return measured
      })

      expect(small, `${name}: every control must grow on a coarse pointer`).toEqual([])
    }
  })

  test("the glyph grows with the control, not just its hit area", async ({ page, gotoSession }) => {
    await gotoSession()
    await page.setViewportSize(VIEWPORTS.tabletLandscape)
    await settle(page)

    // Growing only the box leaves a small glyph floating in a large target,
    // which reads as untouched even though the hit area is correct.
    // The pointer type cannot be emulated per-page, so the coarse rules are
    // collected and applied to measure what a touch device actually renders.
    // Asserting on class names instead would pass on a rule that never wins.
    const measured = await page.evaluate(() => {
      const coarse: string[] = []
      const walk = (list: CSSRuleList) => {
        for (const rule of list) {
          if ((rule as CSSMediaRule).conditionText === "(any-pointer: coarse)") {
            for (const inner of (rule as CSSMediaRule).cssRules) coarse.push(inner.cssText)
            continue
          }
          const nested = (rule as CSSGroupingRule).cssRules
          if (nested) walk(nested)
        }
      }
      for (const sheet of document.styleSheets) {
        try {
          walk(sheet.cssRules)
        } catch {}
      }

      const patch = document.createElement("style")
      patch.textContent = coarse.join("\n")
      document.head.appendChild(patch)

      const titlebar = document.querySelector('[data-slot="titlebar"]')!
      const bar = titlebar.getBoundingClientRect()
      const small: string[] = []
      const clipped: string[] = []

      for (const button of titlebar.querySelectorAll<HTMLElement>("button")) {
        const box = button.getBoundingClientRect()
        if (box.width === 0) continue
        if (box.top < bar.top - 1 || box.bottom > bar.bottom + 1) {
          clipped.push(button.getAttribute("aria-label") ?? "unnamed")
        }
        const icon = button.querySelector("[data-component=icon]")
        if (!icon) continue
        if (icon.getBoundingClientRect().width < 20) {
          small.push(button.getAttribute("aria-label") ?? "unnamed")
        }
      }

      patch.remove()
      return { small, clipped }
    })

    expect(measured.small, "a touch-sized control must scale its glyph too").toEqual([])
    expect(measured.clipped, "the bar must grow with the controls it holds").toEqual([])
  })

  test("a glyph sits comfortably inside its control, neither cramped nor lost", async ({ page, gotoSession }) => {
    await gotoSession()
    await page.setViewportSize(VIEWPORTS.tabletLandscape)
    await settle(page)

    // A glyph adrift in an oversized box and one pressed against the edge are
    // both wrong, and neither shows up in a size check. The ratio holds for
    // whichever pointer is in use, so this reads the page as rendered.
    const wrong = await page.evaluate(() =>
      [
        ...document.querySelectorAll<HTMLElement>(
          '[data-slot="titlebar"] button, [data-component="prompt-input"] button',
        ),
      ]
        .filter((button) => {
          const box = button.getBoundingClientRect()
          return box.width >= 8 && box.height >= 8
        })
        .map((button) => {
          const icon = button.querySelector("[data-component=icon]")
          if (!icon) return null
          const box = button.getBoundingClientRect()
          const glyph = icon.getBoundingClientRect()
          if (glyph.width < 4) return null
          const ratio = glyph.width / Math.min(box.width, box.height)
          if (ratio >= 0.35 && ratio <= 0.85) return null
          return `${button.getAttribute("aria-label") ?? "unnamed"} ${Math.round(ratio * 100)}%`
        })
        .filter((entry): entry is string => entry !== null),
    )

    expect(wrong, "a glyph should fill between a third and five sixths of its control").toEqual([])
  })

  // A control is measured against the nearest ancestor that actually draws an
  // edge, not its immediate parent: a shrink-wrapped flex wrapper is the same
  // height as the control by construction and would report every control as
  // flush. An ancestor whose edge is softened by a gradient ::after is not an
  // edge to hug either, so it is skipped rather than reported.
  const flushControls = () => {
    const coarse: string[] = []
    const walk = (list: CSSRuleList) => {
      for (const rule of list) {
        if ((rule as CSSMediaRule).conditionText === "(any-pointer: coarse)") {
          for (const inner of (rule as CSSMediaRule).cssRules) coarse.push(inner.cssText)
          continue
        }
        const nested = (rule as CSSGroupingRule).cssRules
        if (nested) walk(nested)
      }
    }
    for (const sheet of document.styleSheets) {
      try {
        walk(sheet.cssRules)
      } catch {}
    }
    const patch = document.createElement("style")
    patch.textContent = coarse.join("\n")
    document.head.appendChild(patch)

    const paints = (style: CSSStyleDeclaration) =>
      style.backgroundColor !== "rgba(0, 0, 0, 0)" ||
      parseFloat(style.borderTopWidth) > 0 ||
      parseFloat(style.borderBottomWidth) > 0 ||
      style.boxShadow !== "none"
    const faded = (el: Element) => {
      const after = getComputedStyle(el, "::after")
      return after.height !== "0px" && (after.backgroundImage || "").includes("gradient")
    }
    const edge = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
        if (p.getBoundingClientRect().height < 8) continue
        if (paints(getComputedStyle(p))) return faded(p) ? null : p
      }
      return null
    }
    const onscreen = (el: Element) => {
      const box = el.getBoundingClientRect()
      return box.bottom > 0 && box.top < innerHeight && box.width > 8 && box.height > 8
    }
    const name = (el: Element) =>
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      el.getAttribute("data-component") ||
      el.getAttribute("data-slot") ||
      (el.textContent || "").trim().slice(0, 20) ||
      "unnamed"

    const flush: string[] = []
    for (const el of document.querySelectorAll(
      'button, [data-component="icon-button"], [data-component="chip-group"], input, textarea',
    )) {
      if (!onscreen(el)) continue
      if (!paints(getComputedStyle(el))) continue
      const bound = edge(el)
      if (!bound || !onscreen(bound)) continue
      const box = el.getBoundingClientRect()
      const bounds = bound.getBoundingClientRect()
      if (bounds.height - box.height < 2) continue
      if (box.top - bounds.top < 1.5 || bounds.bottom - box.bottom < 1.5) {
        flush.push(`${name(el)} in ${name(bound)}`)
      }
    }
    patch.remove()
    return [...new Set(flush)]
  }

  test("a filled control has room inside the row it sits in", async ({ page, gotoSession }) => {
    await gotoSession()
    await page.setViewportSize(VIEWPORTS.tabletPortrait)
    await settle(page)

    // A row that takes its height from its tallest child leaves a painted
    // button touching the row edge, which reads as clipped however well the
    // glyph is centred inside it. Measured with the coarse rules applied,
    // because a target grown for touch is the one that runs out of room.
    const flush = await page.evaluate(flushControls)

    expect(flush, "a painted control needs space between it and its row").toEqual([])
  })

  test("an overview row reserves room for a touch target rather than being filled by one", async ({ page, sdk }) => {
    // A row exists only where a session does, and the row's stop button needs a
    // live cache ping on top of that, which takes a real turn. So the row is
    // measured directly: a row that reserves no more than the target it must
    // hold leaves that target flush against both its edges, and the only way to
    // seat a bigger control in an unchanged row is to cancel the row's padding.
    await withSession(sdk, "row spacing probe", async () => {
      await page.goto("/")
      await page.setViewportSize(VIEWPORTS.tabletPortrait)
      await settle(page)

      const rows = await page.evaluate(() => {
        const coarse: string[] = []
        const walk = (list: CSSRuleList) => {
          for (const rule of list) {
            if ((rule as CSSMediaRule).conditionText === "(any-pointer: coarse)") {
              for (const inner of (rule as CSSMediaRule).cssRules) coarse.push(inner.cssText)
              continue
            }
            const nested = (rule as CSSGroupingRule).cssRules
            if (nested) walk(nested)
          }
        }
        for (const sheet of document.styleSheets) {
          try {
            walk(sheet.cssRules)
          } catch {}
        }
        const patch = document.createElement("style")
        patch.textContent = coarse.join("\n")
        document.head.appendChild(patch)

        const measured = [...document.querySelectorAll('[data-slot="list-item"]')].slice(0, 5).map((row) => {
          const style = getComputedStyle(row)
          return {
            height: Math.round(row.getBoundingClientRect().height),
            padding: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom),
          }
        })
        patch.remove()
        return measured
      })

      expect(rows.length, "the overview must render rows to measure").toBeGreaterThan(0)

      const cramped = rows.filter((row) => row.height < COARSE_TARGET + row.padding)
      expect(cramped, "a row must reserve its padding around a touch-sized control").toEqual([])
    })
  })

  test("growing a control for touch does not overflow the row holding it", async ({ page, gotoSession }) => {
    await gotoSession()
    await page.setViewportSize(VIEWPORTS.tabletLandscape)
    await settle(page)

    // Enlarging a target is only safe if its container yields. A row with a
    // fixed height clips the bigger control instead of growing with it, which
    // turns a fixed target into a hidden one.
    const clipped = await page.evaluate(() => {
      const forced = document.createElement("style")
      forced.textContent = `
        [data-slot="titlebar"] button,
        [data-component="prompt-input"] button,
        [data-component="question-panel"] button {
          min-width: 44px !important;
          min-height: 44px !important;
        }
      `
      document.head.appendChild(forced)

      const overflowing = [...document.querySelectorAll<HTMLElement>("button")]
        .filter((button) => button.getBoundingClientRect().width > 0)
        .filter((button) => {
          const parent = button.parentElement
          if (!parent) return false
          const box = button.getBoundingClientRect()
          const bounds = parent.getBoundingClientRect()
          if (getComputedStyle(parent).overflow === "visible") return false
          return box.bottom > bounds.bottom + 1 || box.right > bounds.right + 1
        })
        .map((button) => button.getAttribute("aria-label") ?? "unnamed")

      forced.remove()
      return overflowing
    })

    expect(clipped, "a touch-sized control must not be clipped by its row").toEqual([])
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

    // An element positioned over the bar with pointer-events:auto silently
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

  test("the roomy chrome sheds controls rather than stacking them", async ({ page, gotoSession }) => {
    await gotoSession()

    // Asking for the wide layout on a phone is a legitimate request, so it has
    // to degrade: a row of fixed-width controls that refuses to shrink puts one
    // control on top of the next instead of giving way.
    for (const name of ["phone", "tabletPortrait", "desktop"] as const) {
      await page.setViewportSize(VIEWPORTS[name])
      await settle(page)
      // Driven through the control rather than storage, so the path a user
      // would take is the path under test.
      for (let press = 0; press < 3 && (await sizeClass(page)) !== "expanded"; press++) {
        await page.locator("[aria-label*='layout']").locator("visible=true").first().click()
        await settle(page)
      }
      expect(await sizeClass(page), `${name}: the cycle must offer the wide layout`).toBe("expanded")

      const collisions = await page.evaluate(() => {
        const boxes = [...document.querySelectorAll<HTMLElement>('[data-slot="titlebar"] button')]
          .filter((button) => button.getBoundingClientRect().width > 0)
          .map((button) => ({
            label: button.getAttribute("aria-label") ?? "unnamed",
            rect: button.getBoundingClientRect(),
          }))
          .sort((a, b) => a.rect.left - b.rect.left)

        return boxes
          .slice(0, -1)
          .filter((entry, index) => entry.rect.right > boxes[index + 1].rect.left + 1)
          .map((entry, index) => `${entry.label} over ${boxes[index + 1].label}`)
      })

      expect(collisions, `${name}: forced wide layout must not overlap its own controls`).toEqual([])
    }
  })

  test("the layout control survives every layout it can produce", async ({ page, gotoSession }) => {
    await gotoSession()

    // Whatever a narrow bar sheds, it cannot shed this one: a forced layout is
    // only undoable from here, so losing it strands the user in the layout they
    // picked with no way back short of clearing storage.
    for (const name of ["phone", "tabletPortrait", "desktop"] as const) {
      await page.setViewportSize(VIEWPORTS[name])
      await settle(page)

      const visible = () =>
        page.evaluate(
          () =>
            [...document.querySelectorAll<HTMLElement>("[aria-label*='layout']")].filter(
              (button) => button.getBoundingClientRect().width > 0,
            ).length,
        )

      expect(await visible(), `${name}: the control must be reachable before forcing`).toBe(1)

      await page.locator("[aria-label*='layout']").locator("visible=true").first().click()
      await settle(page)

      expect(await visible(), `${name}: the control must survive the layout it just forced`).toBe(1)

      await page.locator("[aria-label*='layout']").locator("visible=true").first().click()
      await settle(page)
    }
  })

  test("the search box keeps its place between the indicator and the layout control", async ({ page, gotoSession }) => {
    await gotoSession()

    for (const width of [700, 760, 900, 1280, 1600]) {
      await page.setViewportSize({ width, height: 800 })
      await settle(page)

      const row = await page.evaluate(() => {
        const bar = document.querySelector('[data-slot="titlebar"]')!
        const seen = [...bar.querySelectorAll<HTMLElement>("button")]
          .filter((button) => button.getBoundingClientRect().width > 0)
          .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
        const find = (match: (label: string) => boolean) =>
          seen.findIndex((button) => match(button.getAttribute("aria-label") ?? ""))
        return {
          indicator: find((label) => label === "Status"),
          search: find((label) => /search files/i.test(label)),
          layout: find((label) => /layout/i.test(label)),
        }
      })

      expect(row.search, `${width}px: the search box must be present`).toBeGreaterThanOrEqual(0)
      expect(row.indicator, `${width}px: the indicator sits left of the search box`).toBe(row.search - 1)
      expect(row.layout, `${width}px: the layout control sits right of the search box`).toBe(row.search + 1)
    }
  })

  test("a search box in a column too narrow for it gives way instead of covering its neighbours", async ({
    page,
    gotoSession,
  }) => {
    await gotoSession()
    // Narrow enough that the column is under the box's fixed width, while the
    // box is still shown: wider and the column has room either way, narrower
    // and the box is gated away, so neither width can tell the two apart.
    await page.setViewportSize({ width: 700, height: 800 })
    await settle(page)

    // A fixed-width box in a shrinking column overflows in both directions, and
    // it is opaque, so the controls it covers read as missing rather than
    // overlapped.
    for (let press = 0; press < 3 && (await sizeClass(page)) !== "expanded"; press++) {
      await page.locator("[aria-label*='layout']").locator("visible=true").first().click()
      await settle(page)
    }
    expect(await sizeClass(page)).toBe("expanded")

    const measured = await page.evaluate(() => {
      const bar = document.querySelector('[data-slot="titlebar"]')!
      const boxes = [...bar.querySelectorAll<HTMLElement>("button")]
        .filter((button) => button.getBoundingClientRect().width > 0)
        .map((button) => ({
          label: button.getAttribute("aria-label") ?? "unnamed",
          rect: button.getBoundingClientRect(),
        }))
        .sort((a, b) => a.rect.left - b.rect.left)

      const search = bar.querySelector<HTMLElement>("[aria-label*='Search files']")
      const column = search?.parentElement?.parentElement
      return {
        overlaps: boxes
          .slice(0, -1)
          .filter((entry, index) => entry.rect.right > boxes[index + 1].rect.left + 1)
          .map((entry, index) => `${entry.label} over ${boxes[index + 1].label}`),
        spill:
          search && column
            ? Math.round(search.getBoundingClientRect().width - column.getBoundingClientRect().width)
            : 0,
      }
    })

    expect(measured.overlaps, "no control may be painted over by the search box").toEqual([])
    expect(measured.spill, "the search box must not exceed the column holding it").toBeLessThanOrEqual(0)
  })

  test("the titlebar offers no keep-warm control", async ({ page, gotoSession }) => {
    await gotoSession()

    for (const name of ["phone", "desktop"] as const) {
      await page.setViewportSize(VIEWPORTS[name])
      await settle(page)

      const warm = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('[data-slot="titlebar"] button')]
          .filter((button) => /warm|cache/i.test(button.getAttribute("aria-label") ?? ""))
          .map((button) => button.getAttribute("aria-label")),
      )

      expect(warm, `${name}: keep-warm is not a titlebar control`).toEqual([])
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
