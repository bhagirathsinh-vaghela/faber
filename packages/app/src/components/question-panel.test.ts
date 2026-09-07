import { describe, expect, test } from "bun:test"
import { actsOnFirstPress } from "./question-panel-guard"

// The defocused-press guard swallows the first tap on an option ROW (so a stray
// tap only focuses the panel rather than answering). A genuine control must not
// be swallowed, or it takes two taps: the bug that started this — the custom
// answer's submit check needing a first tap to focus and a second to submit.

describe("actsOnFirstPress", () => {
  const el = (html: string) => {
    const host = document.createElement("div")
    host.innerHTML = html
    return host.firstElementChild as HTMLElement
  }

  test("the submit/add check button (an IconButton) acts on the first press", () => {
    expect(actsOnFirstPress(el('<button data-component="icon-button"></button>'))).toBe(true)
  })

  test("the mic (a Button) acts on the first press", () => {
    expect(actsOnFirstPress(el('<button data-component="button"></button>'))).toBe(true)
  })

  test("a glyph inside a control counts, since the press target is the child", () => {
    const control = el('<button data-component="icon-button"><span data-slot="icon"></span></button>')
    expect(actsOnFirstPress(control.querySelector("span"))).toBe(true)
  })

  test("the collapse header acts on the first press", () => {
    expect(actsOnFirstPress(el("<button data-question-collapse></button>"))).toBe(true)
  })

  test("an option row (a raw button, no data-component) is swallowed", () => {
    expect(actsOnFirstPress(el("<button></button>"))).toBe(false)
  })

  test("null is not a control, which is what a press off any element reads as", () => {
    expect(actsOnFirstPress(null)).toBe(false)
  })
})
