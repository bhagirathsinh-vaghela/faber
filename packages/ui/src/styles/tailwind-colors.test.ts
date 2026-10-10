import { expect, test } from "bun:test"
import { DEFAULT_THEMES } from "../theme/default-themes"
import { resolveThemeVariant } from "../theme/resolve"

// Tailwind v4 only generates a `text-<token>` utility for a color declared in
// the @theme block (which starts from `--color-*: initial`), so a text token the
// resolver emits without an alias here silently renders no color.
test("every resolved text token has a Tailwind color alias", async () => {
  const css = await Bun.file(import.meta.dir + "/tailwind/colors.css").text()
  const tokens = Object.keys(resolveThemeVariant(DEFAULT_THEMES["oc-1"].dark, true))
  const missing = tokens.filter((t) => t.startsWith("text-") && !css.includes(`--color-${t}: var(--${t});`))
  expect(missing).toEqual([])
})
