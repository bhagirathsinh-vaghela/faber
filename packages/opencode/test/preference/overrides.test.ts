import { describe, test, expect } from "bun:test"
import { legacyOverrides } from "../../src/preference/overrides"

function theme(light: Record<string, string>, dark: Record<string, string> = {}) {
  return { id: "t", overrides: { light, dark } }
}

describe("legacyOverrides", () => {
  test("an override saved under a renamed token keeps applying, under the current name", () => {
    const value = legacyOverrides(theme({ "--box-accent-task": "#c99813", "--box-bg-task": "#111c1d" }))
    expect(value.overrides.light).toEqual({
      "--box-accent-subagent": "#c99813",
      "--box-bg-subagent": "#111c1d",
    })
  })

  test("a value saved under the current name wins over the old one", () => {
    const value = legacyOverrides(theme({ "--box-accent-task": "#c99813", "--box-accent-subagent": "#ff0000" }))
    expect(value.overrides.light).toEqual({ "--box-accent-subagent": "#ff0000" })
  })

  test("both modes are read forward independently", () => {
    const value = legacyOverrides(theme({ "--box-border-task": "#111" }, { "--box-border-task": "#222" }))
    expect(value.overrides.light).toEqual({ "--box-border-subagent": "#111" })
    expect(value.overrides.dark).toEqual({ "--box-border-subagent": "#222" })
  })

  test("unrelated overrides are untouched, and the record is returned as-is", () => {
    const input = theme({ "--text-base": "#abc" })
    const value = legacyOverrides(input)
    expect(value).toBe(input)
  })
})
