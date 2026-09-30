import { expect, test } from "bun:test"
import { lazy } from "./lazy"

test("the initializer runs once and its value is kept", () => {
  const calls = { count: 0 }
  const get = lazy(() => ++calls.count)
  expect([get(), get(), get()]).toEqual([1, 1, 1])
  expect(calls.count).toBe(1)
})

test("an initializer that throws throws again on the next call", () => {
  const calls = { count: 0 }
  const get = lazy(() => {
    calls.count++
    throw new Error("no adapter")
  })
  expect(() => get()).toThrow("no adapter")
  expect(() => get()).toThrow("no adapter")
  expect(calls.count).toBe(2)
})
