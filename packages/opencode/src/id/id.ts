import z from "zod"
import { randomBytes } from "crypto"

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

  export function schema(prefix: keyof typeof prefixes) {
    return z.string().startsWith(prefixes[prefix])
  }

  const TIME_BYTES = 8
  const RANDOM_CHARS = 14

  let lastTimestamp = 0
  let counter = 0

  export function seed(timestamp: number) {
    if (timestamp > lastTimestamp) {
      lastTimestamp = timestamp
      counter = 0
    }
  }

  export function ascending(prefix: keyof typeof prefixes, given?: string) {
    return generateID(prefix, false, given)
  }

  export function descending(prefix: keyof typeof prefixes, given?: string) {
    return generateID(prefix, true, given)
  }

  const DESCENDING = new Set<string>([prefixes.session])

  function generateID(prefix: keyof typeof prefixes, descending: boolean, given?: string): string {
    if (!given) {
      return create(prefix, descending)
    }

    if (!given.startsWith(prefixes[prefix])) {
      throw new Error(`ID ${given} does not start with ${prefixes[prefix]}`)
    }
    return given
  }

  function randomBase62(length: number): string {
    const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    let result = ""
    const bytes = randomBytes(length)
    for (let i = 0; i < length; i++) {
      result += chars[bytes[i] % 62]
    }
    return result
  }

  export function create(prefix: keyof typeof prefixes, descending: boolean, timestamp?: number): string {
    const currentTimestamp = timestamp ?? Date.now()

    if (currentTimestamp > lastTimestamp) {
      lastTimestamp = currentTimestamp
      counter = 0
    }
    counter++

    let now = BigInt(lastTimestamp) * BigInt(0x1000) + BigInt(counter)

    now = descending ? ~now : now

    const timeBytes = Buffer.alloc(TIME_BYTES)
    for (let i = 0; i < TIME_BYTES; i++) {
      timeBytes[i] = Number((now >> BigInt((TIME_BYTES - 1 - i) * 8)) & BigInt(0xff))
    }

    return prefixes[prefix] + "_" + timeBytes.toString("hex") + randomBase62(RANDOM_CHARS)
  }

  export function timestamp(id: string): number {
    const prefix = id.split("_")[0]
    const body = id.slice(prefix.length + 1)
    const hexLen = body.length <= 26 ? 12 : 16
    const encoded = BigInt("0x" + body.slice(0, hexLen))
    // Descending ids store the complement, so reading one without inverting it
    // yields a value near the width ceiling rather than a time.
    const value = DESCENDING.has(prefix) ? ((1n << BigInt(hexLen * 4)) - 1n) & ~encoded : encoded
    return Number(value / BigInt(0x1000))
  }
}
