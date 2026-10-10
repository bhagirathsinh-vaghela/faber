import { describe, expect, test } from "bun:test"
import { present } from "./sync"

describe("present", () => {
  test("a session the server reports NotFound is gone", async () => {
    expect(await present(Promise.reject({ name: "NotFoundError", data: {} }))).toBe(false)
  })

  test("a read that fails for another reason keeps the session", async () => {
    expect(await present(Promise.reject(new TypeError("Failed to fetch")))).toBe(true)
  })

  test("an archived session is gone", async () => {
    expect(await present(Promise.resolve({ data: { id: "s", time: { archived: 1 } } }))).toBe(false)
  })

  test("a live session is present", async () => {
    expect(await present(Promise.resolve({ data: { id: "s", time: {} } }))).toBe(true)
  })
})
