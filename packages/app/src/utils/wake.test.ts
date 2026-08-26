import { describe, expect, test } from "bun:test"

// Mirrors the reconnect loop's interruptible backoff in global-sdk. Held here
// rather than exported from the context, which cannot be constructed without a
// live server and a Solid owner.
function createSleeper() {
  let wake: { generation: number; resolve: () => void } | undefined
  let generation = 0
  let pendingWake = false

  const nudge = () => {
    if (!wake) {
      pendingWake = true
      return
    }
    wake.resolve()
    wake = undefined
  }

  const sleep = (ms: number) => {
    if (pendingWake) {
      pendingWake = false
      return Promise.resolve()
    }
    generation++
    const mine = generation
    return new Promise<void>((resolve) => {
      wake = { generation: mine, resolve }
      setTimeout(() => {
        if (wake?.generation !== mine) return
        wake = undefined
        resolve()
      }, ms)
    })
  }

  return { nudge, sleep }
}

const elapsed = async (fn: () => Promise<void>) => {
  const start = Date.now()
  await fn()
  return Date.now() - start
}

describe("interruptible backoff", () => {
  test("a nudge releases the current sleep immediately", async () => {
    const { nudge, sleep } = createSleeper()
    const took = await elapsed(async () => {
      const pending = sleep(5000)
      setTimeout(nudge, 20)
      await pending
    })
    expect(took).toBeLessThan(500)
  })

  // The superseded timer from an interrupted sleep fires long after its own
  // sleep ended. Releasing the sleep it finds would cut a later backoff short,
  // and clearing the slot would leave every future nudge with nothing to wake.
  test("a late timer from an interrupted sleep cannot disturb a later one", async () => {
    const { nudge, sleep } = createSleeper()

    const first = sleep(60)
    nudge()
    await first

    const took = await elapsed(async () => {
      const second = sleep(400)
      // Outlives the first sleep's timer, so it fires while this one is live.
      await second
    })

    expect(took).toBeGreaterThanOrEqual(350)
  })

  test("a nudge still wakes a sleep started after the stale timer fired", async () => {
    const { nudge, sleep } = createSleeper()

    const first = sleep(40)
    nudge()
    await first
    await new Promise((resolve) => setTimeout(resolve, 80))

    const took = await elapsed(async () => {
      const second = sleep(5000)
      setTimeout(nudge, 20)
      await second
    })

    expect(took).toBeLessThan(500)
  })

  // The loop aborts the stream and nudges before it reaches its sleep, so a
  // signal that arrives early has to survive until there is something to wake.
  test("a nudge arriving before the loop sleeps is not lost", async () => {
    const { nudge, sleep } = createSleeper()
    nudge()
    const took = await elapsed(async () => {
      await sleep(5000)
    })
    expect(took).toBeLessThan(200)
  })

  test("a remembered nudge is spent once, not held forever", async () => {
    const { nudge, sleep } = createSleeper()
    nudge()
    await sleep(5000)
    const took = await elapsed(async () => {
      await sleep(120)
    })
    expect(took).toBeGreaterThanOrEqual(100)
  })
})
