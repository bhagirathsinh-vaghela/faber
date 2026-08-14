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
 */
export function settled(signal: AbortSignal): Promise<typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED)
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(ABORTED), { once: true }))
}
