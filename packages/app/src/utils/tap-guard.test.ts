import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

// A raw <button> that is control-shaped (a fixed square box holding an icon,
// sized off --control-height or a `size-N`) steals focus when tapped next to a
// focused editable, and on iOS that blur costs the first tap. The shared
// Button/IconButton primitive cancels the focus shift; a raw one that cannot use
// the primitive (an emoji glyph, a bespoke badge) must spread preserveFocus()
// instead. This scan fails a control-shaped raw <button> that does neither, so a
// new one cannot reintroduce the two-tap bug. Region buttons (rows, bars, links)
// are not control-shaped and are not matched.

const SRC = join(import.meta.dir, "..")

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path)
    return name.endsWith(".tsx") ? [path] : []
  })
}

// `h-` must start the class: a min-h-/max-h- floor sizes a row, not a fixed box.
const CONTROL_SIZED = /\bsize-\((?:length:)?--control-(?:height|icon)\)|(?<![\w-])h-\(--control-height\)/
const HAS_PRESERVE = /preserveFocus\(\)/

// Each raw <button ...> opening tag, from `<button` to the `>` that ends it.
// JSX expressions ({...}) hold `>` and `=>`, so a `[^>]` regex ends the tag
// early. Track brace depth and take the first `>` at depth zero.
function openingTags(source: string) {
  const tags: string[] = []
  let from = source.indexOf("<button")
  while (from !== -1) {
    let depth = 0
    for (let i = from; i < source.length; i++) {
      const c = source[i]
      if (c === "{") depth++
      else if (c === "}") depth--
      else if (c === ">" && depth === 0) {
        tags.push(source.slice(from, i + 1))
        break
      }
    }
    from = source.indexOf("<button", from + 1)
  }
  return tags
}

test("the control-size pattern matches a control box and nothing that only floors a row", () => {
  const matches = [
    'class="h-(--control-height) p-1"',
    'class="shrink h-(--control-height) p-1"',
    'class="md:h-(--control-height)"',
    'class="size-(--control-height)"',
    'class="size-(length:--control-icon)"',
  ]
  const misses = ['class="min-h-(--control-height)"', 'class="max-h-(--control-height)"', 'class="h-8"']
  expect(matches.map((tag) => CONTROL_SIZED.test(tag))).toEqual(matches.map(() => true))
  expect(misses.map((tag) => CONTROL_SIZED.test(tag))).toEqual(misses.map(() => false))
})

describe("control-shaped raw buttons keep single-tap on touch", () => {
  for (const file of files(SRC)) {
    const source = readFileSync(file, "utf8")
    for (const tag of openingTags(source)) {
      if (!CONTROL_SIZED.test(tag)) continue
      const rel = file.slice(SRC.length + 1)
      test(`${rel}: a control-sized raw <button> spreads preserveFocus()`, () => {
        expect(HAS_PRESERVE.test(tag), tag.slice(0, 120)).toBe(true)
      })
    }
  }
})
