export function lazy<T>(fn: () => T) {
  let value: T | undefined
  let loaded = false

  const result = (): T => {
    // A rejected promise must not stay memoized: an async body that fails once
    // (a lock held at the moment a connection opens) would otherwise hand the
    // same rejection to every later caller, turning a transient failure into a
    // permanently broken process.
    //
    // The state is INSPECTED rather than subscribed to, because attaching any
    // rejection handler marks the promise handled and silences the runtime's
    // unhandled-rejection report. A caller that handles the failure itself
    // would then log an error for something nothing went wrong with, and one
    // that drops it would log nothing at all: both backwards.
    if (loaded) {
      if (!(value instanceof Promise) || Bun.peek.status(value) !== "rejected") return value as T
      loaded = false
      value = undefined
    }
    // Marked loaded only once fn returns, so an initializer that throws throws
    // again on the next call instead of latching undefined.
    value = fn()
    loaded = true
    return value as T
  }

  result.reset = () => {
    loaded = false
    value = undefined
  }

  return result
}
