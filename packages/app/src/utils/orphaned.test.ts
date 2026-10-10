import { describe, expect, test } from "bun:test"
import { orphaned } from "./orphaned"

describe("orphaned", () => {
  test("keeps the session the view is showing", () => {
    expect(orphaned("ses_a", "ses_a")).toBe(false)
  })

  test("deletes it when the view shows no session", () => {
    expect(orphaned("ses_a", undefined)).toBe(true)
  })

  test("deletes it when the view shows another session", () => {
    expect(orphaned("ses_a", "ses_b")).toBe(true)
  })
})
