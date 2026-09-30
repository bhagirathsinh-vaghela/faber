import { expect, test } from "bun:test"
import { handle, ignored } from "./speech-keys"

const press = (target: Element, init: KeyboardEventInit = {}) => {
  const root = target.isConnected ? undefined : target
  if (root) document.body.append(root)
  const seen: boolean[] = []
  target.addEventListener("keydown", (e) => seen.push(ignored(e as KeyboardEvent)))
  target.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, ...init }))
  root?.remove()
  return seen[0]
}

const editable = (value: string) => {
  const host = document.createElement("div")
  host.setAttribute("contenteditable", value)
  const inner = document.createElement("span")
  host.append(inner)
  return { host, inner }
}

test("a key on the page is handled", () => {
  expect(press(document.createElement("div"))).toBe(false)
})

test("a key inside a field is left to the field", () => {
  expect(press(document.createElement("select"))).toBe(true)
  expect(press(document.createElement("input"))).toBe(true)
  expect(press(document.createElement("textarea"))).toBe(true)
})

test("a key inside the composer's contenteditable is left to it", () => {
  const { host, inner } = editable("true")
  document.body.append(host)
  expect(press(inner)).toBe(true)
  host.remove()
})

test("contenteditable=false is not a field", () => {
  expect(press(editable("false").host)).toBe(false)
})

test("a contenteditable=false element inside the composer is not a field", () => {
  const { host } = editable("true")
  const island = document.createElement("span")
  island.setAttribute("contenteditable", "false")
  host.append(island)
  document.body.append(host)
  expect(island.isContentEditable).toBe(false)
  expect(press(island)).toBe(false)
  host.remove()
})

test("modified keys are left to the page", () => {
  const div = () => document.createElement("div")
  expect(press(div(), { ctrlKey: true })).toBe(true)
  expect(press(div(), { metaKey: true })).toBe(true)
  expect(press(div(), { altKey: true })).toBe(true)
  expect(press(div(), { shiftKey: true })).toBe(true)
})

test("+ is typed with shift on most layouts, so shift does not hide it", () => {
  expect(press(document.createElement("div"), { key: "+", shiftKey: true })).toBe(false)
})

test("a key inside an open list is left to it", () => {
  const list = document.createElement("ul")
  list.setAttribute("role", "listbox")
  const option = document.createElement("li")
  option.setAttribute("role", "option")
  list.append(option)
  document.body.append(list)
  expect(press(option)).toBe(true)
  list.remove()
})

test("a key on a closed picker's button still reaches the HUD", () => {
  const trigger = document.createElement("button")
  trigger.setAttribute("aria-haspopup", "listbox")
  expect(press(trigger)).toBe(false)
})

// Dispatches one keydown at a page element and reports what `handle` did.
const dispatch = (init: KeyboardEventInit, target: Element = document.createElement("div")) => {
  const root = target.isConnected ? undefined : target
  if (root) document.body.append(root)
  const acted: string[] = []
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
  target.addEventListener("keydown", (e) => handle(e as KeyboardEvent, { " ": () => acted.push("toggle") }))
  target.dispatchEvent(event)
  root?.remove()
  return { acted, prevented: event.defaultPrevented }
}

test("a HUD key acts once and is kept from the page", () => {
  expect(dispatch({ key: " " })).toEqual({ acted: ["toggle"], prevented: true })
})

test("a HUD key's auto-repeat is kept from the page without acting again", () => {
  expect(dispatch({ key: " ", repeat: true })).toEqual({ acted: [], prevented: true })
})

test("a key the HUD does not use, or one inside a field, is left alone", () => {
  expect(dispatch({ key: "a" })).toEqual({ acted: [], prevented: false })
  expect(dispatch({ key: " " }, document.createElement("input"))).toEqual({ acted: [], prevented: false })
})
