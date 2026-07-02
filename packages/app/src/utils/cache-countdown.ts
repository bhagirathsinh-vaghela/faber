import type { Session } from "@opencode-ai/sdk/v2/client"

// Mirrors the server's session/ping CACHE_TTL (5 minutes).
export const CACHE_TTL = 5 * 60 * 1000

export function beforeExpiryMs(config: unknown): number {
  return ((config as any)?.ping?.before_expiry ?? 10) * 1000
}

// The single source for "is a cache ping coming, and when" — shared by the
// session statusline and the home hub so they never disagree. Returns the
// mm:ss until the next ping, or null when no ping will fire (no cache anchor,
// window expired, or ping disabled so the anchor never refreshes).
export function cacheCountdown(session: Session | undefined, beforeExpiry: number, now: number): string | null {
  return cacheCountdownFrom(session?.cache?.lastRequestAt, beforeExpiry, now)
}

// Same countdown from the raw cache anchor, for callers (the home overview) that
// hold lastRequestAt directly instead of a full session object.
export function cacheCountdownFrom(base: number | undefined, beforeExpiry: number, now: number): string | null {
  if (!base) return null
  if (base + CACHE_TTL <= now) return null
  const remaining = base + CACHE_TTL - beforeExpiry - now
  if (remaining <= 0) return null
  const mins = Math.floor(remaining / 60000)
  const secs = Math.floor((remaining % 60000) / 1000)
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
}
