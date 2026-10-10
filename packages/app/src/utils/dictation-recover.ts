// Maps a recovery pull to what the dictation controller expects: the held
// text, "gone" when the server holds nothing under the id, or a throw for
// anything worth retrying (a recovery still running, or no answer at all).
export function recovered(pull: { data?: { text: string } | { pending: true }; response?: { status: number } }) {
  if (pull.response?.status === 404) return "gone" as const
  if (pull.data && "text" in pull.data) return pull.data.text
  throw new Error(`dictation recover answered ${pull.response?.status ?? "nothing"}`)
}

// One run per key at a time: a call for the key in flight joins that run, a
// call for any other key starts its own, so a stale pull for an earlier
// dictation never absorbs the next one's.
export function single() {
  let current: { key: string | undefined; done: Promise<void> } | undefined
  return (key: string | undefined, run: () => Promise<void>) => {
    if (current && current.key === key) return current.done
    const entry: { key: string | undefined; done: Promise<void> } = {
      key,
      done: run().finally(() => {
        if (current === entry) current = undefined
      }),
    }
    current = entry
    return entry.done
  }
}
