// A short replay buffer over the global event stream, so a client that loses
// its connection can ask for the frames it missed instead of inferring them.
//
// SSE already specifies this: the server stamps each frame with an `id`, and a
// reconnecting client sends the last one it saw back as `Last-Event-ID`.
// Without it a disconnect is unrecoverable at the protocol level, and the only
// repair left is refetching REST state — which cannot restore a streamed part
// mid-flight and silently leaves the transcript short when it is skipped.
//
// Bounded by count and age together: an idle server must not pin memory for a
// client that will never return, and a busy turn must not evict frames a client
// backgrounded seconds ago still needs. Anything older or larger than the window
// is a miss, and a miss is reported honestly so the caller falls back to the
// full re-bootstrap rather than resuming from a hole.

// A streaming text part resends its whole growing text every chunk, which is
// O(n^2) in the length of a turn. The event carries a `delta` the web client
// appends, so the accumulated field is redundant anywhere the delta travels.
// Cloned, never mutated: the same event object is fanned out to every
// connection and to in-process consumers that need the full text.
export function blankStreamedText(event: any) {
  const p = event?.payload
  if (p?.type !== "message.part.updated") return event
  const part = p.properties?.part
  if (p.properties?.delta === undefined || !part) return event
  if (typeof part.text !== "string") return event
  return { ...event, payload: { ...p, properties: { ...p.properties, part: { ...part, text: "" } } } }
}

export namespace EventReplay {
  export type Frame = {
    id: number
    event: { directory?: string; payload: any }
  }

  // Sized for the gaps a phone actually produces: a tunnel, a dead cell zone, a
  // long stretch in another app. A client that returns inside this window
  // resumes exactly; one that returns outside it still recovers, just via the
  // heavier re-bootstrap. The cost is bounded server memory, paid once, so the
  // window is set by how long people are away rather than by frugality.
  export const LIMIT = 10_000
  const MAX_AGE_MS = 1_800_000

  // Identifies THIS process's id space. Ids restart at 1 on every boot, so a
  // cursor minted by a previous process names a frame that has nothing to do
  // with the one it would resolve to here — and once this process has published
  // past that number, the mismatch stops being detectable by range alone.
  export const EPOCH = crypto.randomUUID()

  const frames: Array<Frame & { at: number }> = []
  let sequence = 0
  // The same event object is fanned out to every connection, so its id is
  // resolved once here rather than assigned per connection — otherwise N
  // clients would mint N ids for one event and every cursor would disagree.
  const assigned = new WeakMap<object, number>()

  export function record(event: { directory?: string; payload: any }) {
    const existing = assigned.get(event)
    if (existing !== undefined) return existing
    sequence++
    assigned.set(event, sequence)
    // Stored in the same delta form the stream sends. A streamed part carries
    // its whole accumulated text on every chunk, so retaining events as
    // published would make the log quadratic in the length of a turn — hundreds
    // of megabytes for one long answer, held until the window expires.
    frames.push({ id: sequence, event: blankStreamedText(event), at: Date.now() })
    prune()
    return sequence
  }

  // An event that somehow reached a connection without passing the bus would
  // otherwise go out unnumbered, leaving the client with a cursor that skips it.
  export function idOf(event: { directory?: string; payload: any }) {
    return assigned.get(event) ?? record(event)
  }

  function prune() {
    const cutoff = Date.now() - MAX_AGE_MS
    let drop = 0
    while (drop < frames.length && (frames.length - drop > LIMIT || frames[drop].at < cutoff)) drop++
    if (drop > 0) frames.splice(0, drop)
  }

  // Frames strictly newer than `after`, or undefined when the buffer cannot
  // prove it holds every one of them. Distinguishing "nothing missed" from
  // "cannot say" is the whole point: resuming from a partially-evicted buffer
  // would skip events while reporting success.
  export function since(after: number, epoch?: string): Frame[] | undefined {
    // A cursor from another process indexes a different id space, so it can
    // only be answered by a full re-bootstrap.
    if (epoch !== EPOCH) return undefined
    if (!Number.isSafeInteger(after)) return undefined
    if (after < 0) return undefined
    if (after > sequence) return undefined
    prune()
    const oldest = frames[0]
    // Everything the client is asking for has already been evicted, unless it
    // is asking for nothing at all.
    if (!oldest) return after === sequence ? [] : undefined
    if (oldest.id > after + 1) return undefined
    return frames.filter((frame) => frame.id > after).map(({ id, event }) => ({ id, event }))
  }

  export function latest() {
    return sequence
  }

  // Frames currently held. The bound this reports is the whole memory story,
  // since nothing else about a client is stored.
  export function size() {
    return frames.length
  }

  export function reset() {
    frames.length = 0
    sequence = 0
  }
}
