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
    if (value instanceof Promise)
      value.catch(() => {
        loaded = false
        value = undefined
      })
    return value as T
  }

  result.reset = () => {
    loaded = false
    value = undefined
  }

  return result
}
