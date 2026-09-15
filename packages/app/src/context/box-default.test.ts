import { describe, expect, test } from "bun:test"
import { boxDefault } from "./settings"

describe("boxDefault", () => {
  test("normal and reader seed no collapse", () => {
    for (const type of ["bash", "edit", "write", "read", "user", "reasoning", "agent", "question"]) {
      expect(boxDefault(type, "normal")).toBe(false)
      expect(boxDefault(type, "reader")).toBe(false)
    }
  })
})
