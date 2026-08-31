import { describe, expect, test } from "bun:test"
import { RATE, storedRate } from "./speak"

const store = (value: string | null) => ({ getItem: () => value }) as Pick<Storage, "getItem">

describe("storedRate", () => {
  test("a previously chosen speed survives a reload", () => {
    expect(storedRate(store("1.5"))).toBe(1.5)
  })

  test("nothing stored yields the resting speed", () => {
    expect(storedRate(store(null))).toBe(RATE.base)
  })

  test("a speed outside the usable range is refused rather than clamped into it", () => {
    expect(storedRate(store("9"))).toBe(RATE.base)
    expect(storedRate(store("0.1"))).toBe(RATE.base)
  })

  test("a corrupt value yields the resting speed", () => {
    expect(storedRate(store("not a number"))).toBe(RATE.base)
  })

  test("storage that throws on access does not break the reading", () => {
    expect(storedRate(undefined)).toBe(RATE.base)
  })

  test("a stored speed lands on a step the buttons can reach", () => {
    const rate = storedRate(store("1.31"))
    expect(Math.round(rate / RATE.step) * RATE.step).toBeCloseTo(rate)
  })
})
