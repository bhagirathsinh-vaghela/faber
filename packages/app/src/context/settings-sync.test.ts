import { describe, expect, test } from "bun:test"
import type { UserTheme } from "@opencode-ai/sdk/v2/client"
import { receive, type Local } from "./settings-sync"

const theme = (id: string, fontSize = 13): UserTheme => ({
  id,
  name: id,
  baseId: "oc-1",
  fontSize,
  font: "jetbrains-mono",
  codeFont: "jetbrains-mono",
  codeTheme: "github-dark",
  diffTheme: "github-dark",
  fontWeight: 400,
  headingWeight: {},
  overrides: { light: {}, dark: {} },
})

const local = (over: Partial<Local<UserTheme>> = {}) => ({
  themes: [theme("a"), theme("b")],
  active: "a",
  dirty: false,
  boxesDirty: false,
  ...over,
})

describe("receive", () => {
  test("a saved box matrix replaces both the saved and the working copy", () => {
    const boxes = { bash: { normal: true } }
    expect(receive(local(), { type: "boxes.preference.updated", properties: boxes })).toEqual({
      boxes,
      draft: boxes,
    })
  })

  test("unsaved box edits survive a save from another client", () => {
    const boxes = { bash: { normal: true } }
    expect(receive(local({ boxesDirty: true }), { type: "boxes.preference.updated", properties: boxes })).toEqual({
      boxes,
    })
  })

  test("an edit to the active theme reloads it", () => {
    const themes = [theme("a", 15), theme("b")]
    expect(receive(local(), { type: "theme.preference.updated", properties: { themes } })).toEqual({
      themes,
      theme: themes[0],
    })
  })

  test("an edit to the active theme leaves unsaved edits alone", () => {
    const themes = [theme("a", 15)]
    expect(receive(local({ dirty: true }), { type: "theme.preference.updated", properties: { themes } })).toEqual({
      themes,
    })
  })

  test("a list without the active theme only replaces the list", () => {
    const themes = [theme("b")]
    expect(receive(local(), { type: "theme.preference.updated", properties: { themes } })).toEqual({ themes })
  })

  test("switching to a known theme loads it", () => {
    expect(receive(local(), { type: "theme.preference.active-updated", properties: { active: "b" } })).toEqual({
      theme: theme("b"),
    })
  })

  test("switching to a theme not yet listed records the pointer for the list that follows", () => {
    const patch = receive(local(), { type: "theme.preference.active-updated", properties: { active: "c" } })
    expect(patch).toEqual({ active: "c" })
    const themes = [theme("a"), theme("b"), theme("c")]
    expect(receive(local({ active: "c" }), { type: "theme.preference.updated", properties: { themes } })).toEqual({
      themes,
      theme: themes[2],
    })
  })

  test("clearing the active theme returns to the plain base", () => {
    expect(receive(local(), { type: "theme.preference.active-updated", properties: { active: null } })).toEqual({
      theme: null,
    })
  })

  test("the echo of this client's own switch changes nothing", () => {
    expect(receive(local(), { type: "theme.preference.active-updated", properties: { active: "a" } })).toEqual({})
  })

  test("a switch from another client leaves unsaved edits alone", () => {
    expect(
      receive(local({ dirty: true }), { type: "theme.preference.active-updated", properties: { active: "b" } }),
    ).toEqual({})
  })

  test("the legacy appearance seeds the editor only with no active theme", () => {
    const { id: _id, name: _name, baseId: _base, ...rest } = theme("x", 16)
    const appearance = { ...rest, codeFont: "jetbrains-mono" }
    const event = { type: "appearance.preference.updated" as const, properties: appearance }
    expect(receive(local({ active: null }), event)).toEqual({ appearance })
    expect(receive(local(), event)).toEqual({})
    expect(receive(local({ active: null, dirty: true }), event)).toEqual({})
  })

  test("other events change nothing", () => {
    expect(receive(local(), { type: "stash.updated", properties: { entries: [] } })).toEqual({})
  })
})
