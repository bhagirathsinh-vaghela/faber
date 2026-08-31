import { describe, expect, test } from "bun:test"
import { isEditable } from "@opencode-ai/ui/util/focus"

describe("isEditable", () => {
  const el = (html: string) => {
    const host = document.createElement("div")
    host.innerHTML = html
    return host.firstElementChild as HTMLElement
  }

  test("the composer is editable, being a contenteditable rather than an input", () => {
    expect(isEditable(el('<div contenteditable="true"></div>'))).toBe(true)
  })

  test("a text input is editable", () => {
    expect(isEditable(el("<input>"))).toBe(true)
  })

  test("a textarea is editable", () => {
    expect(isEditable(el("<textarea></textarea>"))).toBe(true)
  })

  test("a select is editable, since a letter jumps between its options", () => {
    expect(isEditable(el("<select></select>"))).toBe(true)
  })

  test("a button is editable, since space and enter activate it", () => {
    expect(isEditable(el("<button></button>"))).toBe(true)
  })

  test("a descendant of a prevent-autofocus subtree is editable, whatever it is", () => {
    const host = document.createElement("div")
    host.innerHTML = '<div data-prevent-autofocus><span tabindex="0"></span></div>'
    expect(isEditable(host.querySelector("span"))).toBe(true)
  })

  test("the transcript is not editable, so a shortcut fires while reading", () => {
    expect(isEditable(el("<div></div>"))).toBe(false)
  })

  test("a link is not editable", () => {
    expect(isEditable(el('<a href="#"></a>'))).toBe(false)
  })

  test("a contenteditable=false element is not editable", () => {
    expect(isEditable(el('<div contenteditable="false"></div>'))).toBe(false)
  })

  test("null is not editable, which is what a caller passes before anything takes focus", () => {
    expect(isEditable(null)).toBe(false)
  })

  test("the body is not editable, which is what holds focus when nothing else does", () => {
    expect(isEditable(document.body)).toBe(false)
  })
})
