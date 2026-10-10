import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { migrate, renamed, type UserTheme } from "./settings"

const theme = (id: string, fontSize: number): UserTheme => ({
  id,
  name: id,
  baseId: "oc-1",
  fontSize,
  font: "jetbrains-mono",
  codeBlockFont: "jetbrains-mono",
  inlineCodeFont: "jetbrains-mono",
  codeTheme: "github-dark",
  diffTheme: "github-dark",
  fontWeight: 400,
  headingWeight: { 1: 700 },
  overrides: { light: {}, dark: { "--background-base": "#000" } },
})

describe("renamed", () => {
  test("carries the stored theme's own appearance, not another theme's", () => {
    const list = [theme("active", 15), theme("other", 20)]
    expect(renamed(list, "other", "Renamed")).toEqual({ ...theme("other", 20), name: "Renamed" })
  })

  test("an unknown id renames nothing", () => {
    expect(renamed([theme("a", 13)], "missing", "x")).toBeUndefined()
  })
})

// The store is a proxy only in Solid's browser build: run with --conditions=browser.
describe("migrate", () => {
  test("a theme read from a store comes back as a plain copy that can be cloned", () => {
    const [themes] = createStore([theme("a", 15)])
    const appearance = migrate(themes[0])
    expect(structuredClone(appearance)).toEqual(appearance)
    expect(appearance.overrides).toEqual({ light: {}, dark: { "--background-base": "#000" } })
  })
})
