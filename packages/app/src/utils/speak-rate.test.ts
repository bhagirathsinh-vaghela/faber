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

  test("a stored speed lands on the nearest step the buttons can reach", () => {
    expect(storedRate(store("1.31"))).toBe(1.3)
    expect(storedRate(store("1.25"))).toBe(1.3)
    expect(storedRate(store("1.75"))).toBe(1.8)
  })

  test("the steps are tenths, each an exact one-decimal value", () => {
    expect(RATE.step).toBe(0.1)
    const steps = Array.from({ length: 21 }, (_, i) => storedRate(store(String(0.5 + i * 0.1))))
    expect(steps.map(String)).toEqual(
      ["0.5", "0.6", "0.7", "0.8", "0.9", "1", "1.1", "1.2", "1.3", "1.4", "1.5"].concat([
        "1.6",
        "1.7",
        "1.8",
        "1.9",
        "2",
        "2.1",
        "2.2",
        "2.3",
        "2.4",
        "2.5",
      ]),
    )
  })
})
