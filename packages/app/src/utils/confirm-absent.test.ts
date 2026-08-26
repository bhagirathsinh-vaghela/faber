import { describe, expect, test } from "bun:test"
import { confirmAbsent } from "./confirm-absent"

const notFound = () => Promise.reject({ name: "NotFoundError" })
const found = () => Promise.resolve({ info: {} })
const dropped = () => Promise.reject(new TypeError("Failed to fetch"))
const noSleep = () => Promise.resolve()

describe("confirmAbsent", () => {
  // A message that reads back is present, so the draft must not be restored.
  test("a single successful read is not absent", async () => {
    let calls = 0
    const found1 = () => {
      calls++
      return found()
    }
    expect(await confirmAbsent(found1, { sleep: noSleep })).toBe(false)
    expect(calls).toBe(1)
  })

  // A NotFound that holds across every retry is a real absence.
  test("NotFound on every attempt is absent", async () => {
    let calls = 0
    const count = () => {
      calls++
      return notFound()
    }
    expect(await confirmAbsent(count, { attempts: 3, sleep: noSleep })).toBe(true)
    expect(calls).toBe(3)
  })

  // The write settling behind a just-recovered server: NotFound first, then the
  // message appears. Not absent.
  test("a later read finding the message wins over an early NotFound", async () => {
    let calls = 0
    const settle = () => {
      calls++
      return calls === 1 ? notFound() : found()
    }
    expect(await confirmAbsent(settle, { attempts: 3, sleep: noSleep })).toBe(false)
    expect(calls).toBe(2)
  })

  // A read that cannot complete is unknown, never absent.
  test("a failed read is not treated as absent", async () => {
    expect(await confirmAbsent(dropped, { attempts: 3, sleep: noSleep })).toBe(false)
  })
})
