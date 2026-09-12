import { describe, expect, test } from "bun:test"
import { boxDefault } from "./settings"

// Minimal's out-of-box seed: only the pure-text boxes stay expanded; every other
// box type collapses. normal and reader never seed a collapse (default false).
describe("boxDefault", () => {
  test("minimal keeps the pure-text boxes expanded", () => {
    expect(boxDefault("user", "minimal")).toBe(false)
    expect(boxDefault("reasoning", "minimal")).toBe(false)
    expect(boxDefault("agent", "minimal")).toBe(false)
  })

  test("minimal collapses every other box type", () => {
    for (const type of ["bash", "edit", "write", "read", "list", "glob", "grep", "todowrite", "mcp", "question"]) {
      expect(boxDefault(type, "minimal")).toBe(true)
    }
  })

  test("normal and reader seed no collapse", () => {
    expect(boxDefault("bash", "normal")).toBe(false)
    expect(boxDefault("bash", "reader")).toBe(false)
    expect(boxDefault("user", "normal")).toBe(false)
  })
})
