import { describe, expect, test } from "bun:test"
import { shouldAbort } from "./hide-abort"

describe("shouldAbort", () => {
  test("hidden on a coarse-pointer device aborts", () => {
    expect(shouldAbort(true, true)).toBe(true)
  })

  test("hidden on a fine-pointer device keeps the stream", () => {
    expect(shouldAbort(true, false)).toBe(false)
  })

  test("visible on a coarse-pointer device keeps the stream", () => {
    expect(shouldAbort(false, true)).toBe(false)
  })

  test("visible on a fine-pointer device keeps the stream", () => {
    expect(shouldAbort(false, false)).toBe(false)
  })
})
