export function lazy<T>(fn: () => T) {
  let value: T | undefined
  let loaded = false

  const result = (): T => {
    if (loaded) return value as T
    loaded = true
    value = fn()
    // A rejected promise must not be memoized: an async body that fails once
    // (a lock held at the moment a connection opens) would otherwise hand the
    // same rejection to every later caller, turning a transient failure into a
    // permanently broken process. Clearing the flag lets the next call retry.
    //
    // The handler RE-THROWS so the derived promise stays rejected and unhandled.
    // Handling the rejection here instead would mark it handled and silence the
    // runtime's unhandled-rejection report, hiding a failure nobody awaited.
    if (value instanceof Promise)
      void value.then(undefined, (e) => {
        loaded = false
        value = undefined
        throw e
      })
    return value as T
  }

  result.reset = () => {
    loaded = false
    value = undefined
  }

  return result
}
