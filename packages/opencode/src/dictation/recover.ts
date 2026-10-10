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

  // Finishing the dropped socket's audio takes a sidecar round trip, and the
  // client pulls the moment its socket closes, so a pull waits on the recovery
  // still running under its id rather than reading nothing.
  const running = new Map<string, Promise<void>>()

  export function track(id: string, work: Promise<unknown>) {
    running.set(
      id,
      work
        .catch(() => undefined)
        .then(() => {
          running.delete(id)
        }),
    )
  }

  export function put(id: string, text: string) {
    held.set(id, { text, at: Date.now() })
  }

  // Whether the recovery under the id has settled, waiting at most `ms` for it.
  export async function wait(id: string, ms: number) {
    const work = running.get(id)
    if (work) await Promise.race([work, Bun.sleep(ms)])
    return !running.has(id)
  }

  // A pull reads without dropping: a response lost on a dead connection must
  // not lose the transcript. The client releases it once inserted, and the
  // sweep reclaims one it never releases.
  export function peek(id: string) {
    return held.get(id)?.text
  }

  export function release(id: string) {
    held.delete(id)
  }
}
