// Whether the toggle reads "Collapse all": only files in the list count.
export function collapses(open: string[], files: string[]) {
  return open.some((file) => files.includes(file))
}

// The open intent for files not in the list is left as it is, so a file that
// comes back reopens the way it was.
export function toggleAll(open: string[], files: string[]) {
  const kept = open.filter((file) => !files.includes(file))
  if (collapses(open, files)) return kept
  return [...kept, ...files]
}
