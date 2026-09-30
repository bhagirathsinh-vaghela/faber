export function lazy<T>(fn: () => T) {
  let value: T | undefined
  let loaded = false

  // Marked loaded only once fn returns, so an initializer that throws throws
  // again on the next call instead of latching undefined.
  return (): T => {
    if (loaded) return value as T
    value = fn()
    loaded = true
    return value as T
  }
}
