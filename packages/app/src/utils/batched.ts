// For a store that only catches up when the server's update event arrives,
// where each write sends the whole document. Writes made in the same tick
// build on each other's draft rather than on the stale store, so a later write
// does not drop an earlier one's change.
export function batched<T extends object>(read: () => T, write: (doc: T) => void) {
  let draft: T | undefined
  return (next: Partial<T>) => {
    if (!draft) queueMicrotask(() => (draft = undefined))
    draft = { ...(draft ?? read()), ...next }
    write(draft)
  }
}
