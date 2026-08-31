import { describe, expect, test } from "bun:test"
import { typing } from "./command"

describe("typing", () => {
  const composer = () => {
    const el = document.createElement("div")
    el.setAttribute("contenteditable", "true")
    return el
  }
  const transcript = () => document.createElement("div")
  const press = (key: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) =>
    ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent

  test("a bare letter in the composer is text, so no binding may take it", () => {
    expect(typing(press("e"), composer())).toBe(true)
  })

  test("the same letter outside an editable is a command", () => {
    expect(typing(press("e"), transcript())).toBe(false)
  })

  test("a capital is still text, since shift is how it is typed", () => {
    expect(typing(press("E", { shiftKey: true }), composer())).toBe(true)
  })

  test("a space in the composer is text, being printable like any other character", () => {
    expect(typing(press(" "), composer())).toBe(true)
  })

  test("a modified letter in the composer is a command, producing no character", () => {
    expect(typing(press("e", { metaKey: true }), composer())).toBe(false)
    expect(typing(press("e", { ctrlKey: true }), composer())).toBe(false)
    expect(typing(press("e", { altKey: true }), composer())).toBe(false)
  })

  test("escape in the composer is a command, meaning the same inside as out", () => {
    expect(typing(press("Escape"), composer())).toBe(false)
  })

  test("the named navigation keys stay commands inside the composer", () => {
    for (const key of ["Tab", "Home", "End", "ArrowUp", "ArrowDown", "Enter", "Backspace"]) {
      expect(typing(press(key), composer())).toBe(false)
    }
  })

  test("nothing focused is never typing", () => {
    expect(typing(press("e"), null)).toBe(false)
  })
})
