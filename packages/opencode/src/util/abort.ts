/**
 * Creates an AbortController that automatically aborts after a timeout.
 *
 * Uses bind() instead of arrow functions to avoid capturing the surrounding
 * scope in closures. Arrow functions like `() => controller.abort()` capture
 * request bodies and other large objects, preventing GC for the timer lifetime.
 *
 * @param ms Timeout in milliseconds
 * @returns Object with controller, signal, and clearTimeout function
 */
export function abortAfter(ms: number) {
  const controller = new AbortController()
  const id = setTimeout(controller.abort.bind(controller), ms)
  return {
    controller,
    signal: controller.signal,
    clearTimeout: () => globalThis.clearTimeout(id),
  }
}

/**
 * Combines multiple AbortSignals with a timeout.
 *
 * @param ms Timeout in milliseconds
 * @param signals Additional signals to combine
 * @returns Combined signal that aborts on timeout or when any input signal aborts
 */
export function abortAfterAny(ms: number, ...signals: AbortSignal[]) {
  const timeout = abortAfter(ms)
  const signal = AbortSignal.any([timeout.signal, ...signals])
  return {
    signal,
    clearTimeout: timeout.clearTimeout,
  }
}

/**
 * Resolution marker for {@link settled}, distinguishable from any value a raced
 * promise could itself resolve with.
 */
export const ABORTED = Symbol("aborted")

/**
 * A promise that resolves with {@link ABORTED} once the signal aborts, for
 * racing against work that may never settle on its own.
 *
 * It never rejects: a rejection would race as a throw and lose the abort's
 * place in whatever teardown the caller runs.
 *
 * `release` detaches the listener for the case the raced work finishes first,
 * which `{ once: true }` alone does not cover — an undetached listener holds
 * this promise on a signal that outlives the race.
 */
export function settled(signal: AbortSignal) {
  if (signal.aborted) return { promise: Promise.resolve(ABORTED), release: () => {} }
  let onAbort!: () => void
  const promise = new Promise<typeof ABORTED>((resolve) => {
    onAbort = () => resolve(ABORTED)
    signal.addEventListener("abort", onAbort, { once: true })
  })
  return { promise, release: () => signal.removeEventListener("abort", onAbort) }
}

/**
 * The single sleep for every loop that waits on a long-lived signal.
 *
 * `{ once: true }` only detaches a listener that FIRES, so a sleep that resolves
 * normally leaves its listener — and the timer and promise its closure holds —
 * attached for the life of the signal. A daemon signal lives as long as the
 * session, so each tick retains another. Detaching on the resolve path is what
 * makes a loop's memory flat instead of proportional to how long it has run.
 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"))
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException("Aborted", "AbortError"))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
