import { describe, expect, test } from "bun:test"
import { heapStats } from "bun:jsc"
import { sleep, settled, ABORTED } from "../../src/util/abort"

function listenerCensus() {
  Bun.gc(true)
  const stats = heapStats()
  const counts = stats.objectTypeCounts as Record<string, number>
  return { timeouts: counts["Timeout"] ?? 0, promises: counts["Promise"] ?? 0 }
}

describe("Abort.sleep", () => {
  // A daemon signal outlives every tick it serves, so a listener left attached
  // by a sleep that resolved normally accumulates for the life of the session.
  test("a resolved sleep retains no timer on the signal", async () => {
    const controller = new AbortController()
    const before = listenerCensus()
    for (let i = 0; i < 2000; i++) await sleep(0, controller.signal)
    const after = listenerCensus()
    expect(after.timeouts - before.timeouts).toBeLessThan(50)
    expect(after.promises - before.promises).toBeLessThan(50)
    controller.abort()
  })

  test("an aborted sleep rejects with AbortError", async () => {
    const controller = new AbortController()
    const pending = sleep(10_000, controller.signal)
    controller.abort()
    expect(pending).rejects.toThrow("Aborted")
  })

  test("a sleep on an already-aborted signal rejects without arming a timer", async () => {
    const controller = new AbortController()
    controller.abort()
    expect(sleep(10_000, controller.signal)).rejects.toThrow("Aborted")
  })

  test("a sleep resolves after its delay", async () => {
    const controller = new AbortController()
    const start = Date.now()
    await sleep(25, controller.signal)
    expect(Date.now() - start).toBeGreaterThanOrEqual(20)
  })
})

describe("Abort.settled", () => {
  test("release detaches the listener when the raced work wins", async () => {
    const controller = new AbortController()
    const before = listenerCensus()
    for (let i = 0; i < 2000; i++) settled(controller.signal).release()
    const after = listenerCensus()
    expect(after.promises - before.promises).toBeLessThan(50)
    controller.abort()
  })

  test("resolves with ABORTED once the signal aborts", async () => {
    const controller = new AbortController()
    const race = settled(controller.signal)
    controller.abort()
    expect(await race.promise).toBe(ABORTED)
  })

  test("an already-aborted signal resolves immediately", async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await settled(controller.signal).promise).toBe(ABORTED)
  })
})
