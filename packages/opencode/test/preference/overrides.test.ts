import { describe, test, expect } from "bun:test"
import { legacyOverrides } from "../../src/preference/overrides"

function theme(light: Record<string, string>, dark: Record<string, string> = {}) {
  return { id: "t", overrides: { light, dark } }
}

describe("legacyOverrides", () => {
  test("an override saved under a renamed token keeps applying, under the current name", () => {
    const value = legacyOverrides(theme({ "--box-accent-task": "#c99813", "--text-base": "#abc" }))
    expect(value.overrides.light).toEqual({ "--box-accent-subagent": "#c99813", "--text-base": "#abc" })
  })

  test("a value saved under the current name wins over the old one", () => {
    const value = legacyOverrides(theme({ "--box-accent-task": "#c99813", "--box-accent-subagent": "#ff0000" }))
    expect(value.overrides.light).toEqual({ "--box-accent-subagent": "#ff0000" })
  })

  test("both modes are read forward independently", () => {
    const value = legacyOverrides(theme({ "--box-accent-task": "#111" }, { "--box-accent-task": "#222" }))
    expect(value.overrides.light).toEqual({ "--box-accent-subagent": "#111" })
    expect(value.overrides.dark).toEqual({ "--box-accent-subagent": "#222" })
  })

  test("unrelated overrides are untouched, and the record is returned as-is", () => {
    const input = theme({ "--text-base": "#abc" })
    const value = legacyOverrides(input)
    expect(value).toBe(input)
  })
})
