export namespace DictationRecover {
  // A dropped browser socket leaves the finished transcript with nowhere to go,
  // so it waits here under the client-minted id until that client reconnects and
  // pulls it. Held in a plain module map: the id is the only claim on it, and a
  // reload mints a new id, so an orphaned transcript is never fetched and only
  // the sweep reclaims it.
  const TTL_MS = 300_000

  const held = new Map<string, { text: string; at: number }>()

  setInterval(() => {
    const cutoff = Date.now() - TTL_MS
    for (const [id, entry] of held) if (entry.at < cutoff) held.delete(id)
  }, TTL_MS).unref()

  export function put(id: string, text: string) {
    held.set(id, { text, at: Date.now() })
  }

  // One-shot: a pulled transcript is delivered once and dropped, so a second
  // pull (the dual-trigger client fires immediately and again on reconnect)
  // reads nothing rather than re-inserting.
  export function get(id: string) {
    const entry = held.get(id)
    if (!entry) return undefined
    held.delete(id)
    return entry.text
  }
}
