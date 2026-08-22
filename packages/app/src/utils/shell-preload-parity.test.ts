import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { SIZE_CLASS_KEY, SIZE_QUERIES } from "@opencode-ai/ui/util/size-class"

// The pre-paint script cannot import the shared module (it runs before any
// bundle exists), so it carries a copy of the key, the storage kind, and the
// thresholds. This is the guard that keeps the copy honest.

const preload = readFileSync(join(import.meta.dir, "../../public/oc-theme-preload.js"), "utf8")

function threshold(query: string, feature: string) {
  const match = new RegExp(`\\(${feature}: (\\d+)px\\)`).exec(query)
  if (!match) throw new Error(`${feature} not found in query: ${query}`)
  return Number(match[1])
}

describe("oc-theme-preload.js mirrors ui/util/size-class.ts", () => {
  test("storage key and kind", () => {
    expect(preload).toContain(`sessionStorage.getItem("${SIZE_CLASS_KEY}")`)
    expect(preload).not.toContain(`localStorage.getItem("${SIZE_CLASS_KEY}")`)
  })

  test("width and height thresholds", () => {
    const medium = threshold(SIZE_QUERIES.medium, "min-width")
    const expandedWidth = threshold(SIZE_QUERIES.expanded, "min-width")
    const expandedHeight = threshold(SIZE_QUERIES.expanded, "min-height")

    expect(preload).toContain(`innerWidth < ${medium}`)
    expect(preload).toContain(`innerWidth < ${expandedWidth}`)
    expect(preload).toContain(`innerHeight < ${expandedHeight}`)
  })

  test("every size class the module accepts is accepted by the script", () => {
    for (const sizeClass of ["compact", "medium", "expanded"]) {
      expect(preload).toContain(`"${sizeClass}"`)
    }
  })
})
