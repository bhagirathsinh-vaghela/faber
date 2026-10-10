import { describe, expect, test } from "bun:test"
import { actsOnFirstPress, yields } from "./question-panel-guard"

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

describe("yields", () => {
  const page = () => {
    const root = document.createElement("div")
    root.innerHTML = `
      <div data-panel tabindex="-1"><button data-row></button><textarea></textarea></div>
      <button data-outside></button>
      <a href="/x" data-link></a>
      <div role="button" data-role></div>
      <div data-plain></div>
      <div contenteditable="true" data-prompt></div>
    `
    const pick = (name: string) => root.querySelector(`[data-${name}]`)!
    return { panel: pick("panel"), pick }
  }

  test("a button, link or role control outside the panel keeps Enter and Tab", () => {
    const { panel, pick } = page()
    for (const name of ["outside", "link", "role"]) {
      expect([yields(pick(name), panel, "Enter"), yields(pick(name), panel, "Tab")]).toEqual([true, true])
    }
  })

  test("arrows still drive the question from a control outside the panel", () => {
    const { panel, pick } = page()
    expect(yields(pick("outside"), panel, "ArrowDown")).toBe(false)
    expect(yields(pick("outside"), panel, "Escape")).toBe(false)
  })

  test("an option row inside the panel leaves Enter to the question", () => {
    const { panel, pick } = page()
    expect(yields(pick("row"), panel, "Enter")).toBe(false)
  })

  test("the panel itself, a plain element and no focus leave keys to the question", () => {
    const { panel, pick } = page()
    expect(yields(panel, panel, "Enter")).toBe(false)
    expect(yields(pick("plain"), panel, "Enter")).toBe(false)
    expect(yields(null, panel, "Enter")).toBe(false)
  })

  test("an editable keeps every key, inside the panel or out", () => {
    const { panel, pick } = page()
    expect(yields(panel.querySelector("textarea"), panel, "ArrowDown")).toBe(true)
    expect(yields(pick("prompt"), panel, "Enter")).toBe(true)
  })
})
