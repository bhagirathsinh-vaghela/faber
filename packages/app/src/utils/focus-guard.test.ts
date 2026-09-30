import { describe, expect, test } from "bun:test"
import { isEditable, takesPaste } from "@opencode-ai/ui/util/focus"

const el = (html: string) => {
  const host = document.createElement("div")
  host.innerHTML = html
  return host.firstElementChild as HTMLElement
}

// A paste the focused element can't insert goes to the composer instead, so
// only an element that inserts pasted text keeps it.
describe("takesPaste", () => {
  test("the composer takes a paste", () => {
    expect(takesPaste(el('<div contenteditable="true"></div>'))).toBe(true)
  })

  test("a text input takes a paste", () => {
    expect(takesPaste(el("<input>"))).toBe(true)
    expect(takesPaste(el('<input type="search">'))).toBe(true)
  })

  test("a textarea takes a paste", () => {
    expect(takesPaste(el("<textarea></textarea>"))).toBe(true)
  })

  test("the terminal subtree takes a paste, whatever holds focus in it", () => {
    const host = document.createElement("div")
    host.innerHTML = '<div data-prevent-autofocus><span tabindex="0"></span></div>'
    expect(takesPaste(host.querySelector("span"))).toBe(true)
  })

  test("a button does not take a paste, though it takes typed keys", () => {
    expect(takesPaste(el("<button></button>"))).toBe(false)
  })

  test("a select, checkbox or button-type input does not take a paste", () => {
    expect(takesPaste(el("<select></select>"))).toBe(false)
    expect(takesPaste(el('<input type="checkbox">'))).toBe(false)
    expect(takesPaste(el('<input type="button">'))).toBe(false)
  })

  test("the body does not take a paste", () => {
    expect(takesPaste(document.body)).toBe(false)
  })
})

describe("isEditable", () => {
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
