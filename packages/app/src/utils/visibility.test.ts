import { describe, expect, test } from "bun:test"
import { Visibility } from "./visibility"

// happy-dom drives visibilityState off a plain property, so the real document
// is steerable and no mock is needed.
function show(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("Visibility", () => {
  test("hidden tracks the document", async () => {
    show("hidden")
    document.dispatchEvent(new Event("visibilitychange"))
    await settle()
    expect(Visibility.hidden()).toBe(true)

    show("visible")
    document.dispatchEvent(new Event("visibilitychange"))
    await settle()
    expect(Visibility.hidden()).toBe(false)
  })

  // The iOS/iPadOS defect: the page is frozen on app switch and the resume-side
  // visibilitychange never arrives. Recovery must not depend on it.
  test("a resume recovers when visibilitychange is never delivered", async () => {
    show("hidden")
    document.dispatchEvent(new Event("visibilitychange"))
    await settle()
    expect(Visibility.hidden()).toBe(true)

    show("visible")
    window.dispatchEvent(new Event("pageshow"))
    await settle()
    expect(Visibility.hidden()).toBe(false)
  })

  test("a focus event alone is enough to recover", async () => {
    show("hidden")
    document.dispatchEvent(new Event("visibilitychange"))
    await settle()
    expect(Visibility.hidden()).toBe(true)

    show("visible")
    window.dispatchEvent(new Event("focus"))
    await settle()
    expect(Visibility.hidden()).toBe(false)
  })

  test("whenVisible resolves on a resume signalled by any event", async () => {
    show("hidden")
    document.dispatchEvent(new Event("visibilitychange"))
    await settle()

    let released = false
    void Visibility.whenVisible().then(() => {
      released = true
    })
    await settle()
    expect(released).toBe(false)

    show("visible")
    window.dispatchEvent(new Event("pageshow"))
    await settle()
    expect(released).toBe(true)
  })

  test("resumed bumps once per return to the foreground", async () => {
    show("visible")
    document.dispatchEvent(new Event("visibilitychange"))
    await settle()
    const before = Visibility.resumed()

    show("hidden")
    document.dispatchEvent(new Event("visibilitychange"))
    await settle()
    expect(Visibility.resumed()).toBe(before)

    show("visible")
    document.dispatchEvent(new Event("visibilitychange"))
    await settle()
    expect(Visibility.resumed()).toBe(before + 1)
  })

  test("redundant resume signals collapse to one bump", async () => {
    show("hidden")
    document.dispatchEvent(new Event("visibilitychange"))
    await settle()
    const before = Visibility.resumed()

    show("visible")
    document.dispatchEvent(new Event("visibilitychange"))
    window.dispatchEvent(new Event("pageshow"))
    window.dispatchEvent(new Event("focus"))
    document.dispatchEvent(new Event("resume"))
    await settle()

    expect(Visibility.resumed()).toBe(before + 1)
  })

  test("interacting with the page while visible never signals a resume", async () => {
    show("visible")
    document.dispatchEvent(new Event("visibilitychange"))
    await settle()
    const before = Visibility.resumed()

    const input = document.createElement("input")
    document.body.appendChild(input)
    for (let i = 0; i < 50; i++) {
      input.dispatchEvent(new Event("focusin", { bubbles: true }))
      window.dispatchEvent(new Event("focus"))
    }
    await settle()

    expect(Visibility.resumed()).toBe(before)
    input.remove()
  })

  test("the visible poll does not manufacture resumes", async () => {
    show("visible")
    document.dispatchEvent(new Event("visibilitychange"))
    await settle()
    const before = Visibility.resumed()
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(Visibility.resumed()).toBe(before)
  })

  test("the hidden attribute follows the state so paused animations resume", async () => {
    show("hidden")
    document.dispatchEvent(new Event("visibilitychange"))
    await settle()
    expect(document.documentElement.hasAttribute("data-app-hidden")).toBe(true)

    show("visible")
    window.dispatchEvent(new Event("pageshow"))
    await settle()
    expect(document.documentElement.hasAttribute("data-app-hidden")).toBe(false)
  })
})
