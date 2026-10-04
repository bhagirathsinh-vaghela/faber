import { describe, expect, test } from "bun:test"
import { DEFAULT_THEMES } from "./default-themes"
import { resolveThemeVariant } from "./resolve"

// Every resolved theme sets the primary button itself; a token left to the
// theme.css fallback takes its light value whenever the OS is light. Unless a
// theme overrides it, it is the strongest neutral, the same step as
// icon-strong-base.
describe("resolveThemeVariant", () => {
  for (const [id, theme] of Object.entries(DEFAULT_THEMES)) {
    test(`${id}: sets the primary button in both schemes`, () => {
      for (const isDark of [false, true]) {
        const variant = isDark ? theme.dark : theme.light
        const tokens = resolveThemeVariant(variant, isDark)
        const overridden = ["button-primary-base", "icon-strong-base"].some((key) => key in (variant.overrides ?? {}))
        if (overridden) expect(typeof tokens["button-primary-base"]).toBe("string")
        if (!overridden) expect(tokens["button-primary-base"]).toBe(tokens["icon-strong-base"])
      }
    })
  }
})
