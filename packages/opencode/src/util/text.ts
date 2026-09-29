// Replaces `search` with `value` as written. A string replacement reads `$$`,
// `$&`, `` $` `` and `$'` in the inserted text as patterns and rewrites them; a
// function's return value is inserted verbatim.
export function swap(text: string, search: string, value: string, all = false) {
  return all ? text.replaceAll(search, () => value) : text.replace(search, () => value)
}
