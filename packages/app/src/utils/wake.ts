// An interruptible backoff sleep. A nudge arriving while nothing sleeps is
// remembered rather than dropped, since the common ordering is an abort
// immediately followed by a nudge, which lands before the loop has reached its
// sleep. The sleeper is held with the generation that created it so a
// superseded timer firing late cannot release, or silently discard, a later
// sleep.
export function createSleeper() {
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
