import z from "zod"

// The one identifier implementation. The server, the web UI, and enterprise all
// mint ids that get sorted against each other, so a second copy is a second
// sort order waiting to disagree with the first.
export namespace Identifier {
  const prefixes = {
    session: "ses",
    message: "msg",
    permission: "per",
    question: "que",
    user: "usr",
    part: "prt",
    pty: "pty",
    tool: "tool",
  } as const

  export type Prefix = keyof typeof prefixes

  export function schema(prefix: Prefix) {
    return z.string().startsWith(prefixes[prefix])
  }

  const TIME_BYTES = 8
  const RANDOM_CHARS = 14
  const COUNTER_RANGE = 0x1000

  let lastTimestamp = 0
  let counter = 0

  // A restarted process resumes at counter 0, so seeding a bare millisecond
  // re-issues counters the persisted ids already spent — two records then share
  // a time field and fall back to sorting by their random tail.
  export function seed(id: string) {
    const value = counterValue(id)
    if (value > lastTimestamp * COUNTER_RANGE + counter) {
      lastTimestamp = Math.floor(value / COUNTER_RANGE)
      counter = value % COUNTER_RANGE
    }
  }

  export function ascending(prefix?: Prefix, given?: string) {
    return generateID(prefix, false, given)
  }

  export function descending(prefix?: Prefix, given?: string) {
    return generateID(prefix, true, given)
  }

  const DESCENDING = new Set<string>([prefixes.session])

  function generateID(prefix: Prefix | undefined, descending: boolean, given?: string): string {
    if (!given) return create(prefix, descending)
    if (prefix && !given.startsWith(prefixes[prefix])) {
      throw new Error(`ID ${given} does not start with ${prefixes[prefix]}`)
    }
    return given
  }

  // Web Crypto rather than node:crypto, because the browser bundle imports this
  // module too.
  function randomBase62(length: number): string {
    const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    const bytes = new Uint8Array(length)
    crypto.getRandomValues(bytes)
    let result = ""
    for (let i = 0; i < length; i++) {
      result += chars[bytes[i] % 62]
    }
    return result
  }

  export function create(prefix: Prefix | undefined, descending: boolean, timestamp?: number): string {
    const currentTimestamp = timestamp ?? Date.now()

    // Only ever raise the floor. Resetting the counter on a backward clock step
    // re-mints ids that were already issued.
    if (currentTimestamp > lastTimestamp) {
      lastTimestamp = currentTimestamp
      counter = 0
    }
    counter++

    // The counter shares its field with the timestamp, so spilling past the
    // range carries into the milliseconds and decodes as a time this id was
    // never minted at. Borrowing the next millisecond keeps both readable.
    if (counter >= COUNTER_RANGE) {
      lastTimestamp += Math.floor(counter / COUNTER_RANGE)
      counter %= COUNTER_RANGE
    }

    let now = BigInt(lastTimestamp) * BigInt(COUNTER_RANGE) + BigInt(counter)

    now = descending ? ~now : now

    let hex = ""
    for (let i = 0; i < TIME_BYTES; i++) {
      hex += Number((now >> BigInt((TIME_BYTES - 1 - i) * 8)) & BigInt(0xff))
        .toString(16)
        .padStart(2, "0")
    }

    return (prefix ? prefixes[prefix] + "_" : "") + hex + randomBase62(RANDOM_CHARS)
  }

  function counterValue(id: string): number {
    const underscore = id.indexOf("_")
    const prefix = underscore === -1 ? "" : id.slice(0, underscore)
    const body = id.slice(underscore + 1)
    const hexLen = body.length <= 26 ? 12 : 16
    const encoded = BigInt("0x" + body.slice(0, hexLen))
    // Descending ids store the complement, so reading one without inverting it
    // yields a value near the width ceiling rather than a time.
    const value = DESCENDING.has(prefix) ? ((1n << BigInt(hexLen * 4)) - 1n) & ~encoded : encoded
    return Number(value)
  }

  export function timestamp(id: string): number {
    return Math.floor(counterValue(id) / COUNTER_RANGE)
  }
}
