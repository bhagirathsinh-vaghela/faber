// Mirrors the server's session/ping CACHE_TTL (5 minutes).
export const CACHE_TTL = 5 * 60 * 1000

export function beforeExpiryMs(config: unknown): number {
  return ((config as any)?.ping?.before_expiry ?? 10) * 1000
}

// Countdown to an absolute deadline the server already resolved (the next-ping
// timestamp). The client just renders time-remaining against its clock.
export function cacheCountdownUntil(at: number | undefined, now: number): string | null {
  if (!at) return null
  const remaining = at - now
  if (remaining <= 0) return null
  return format(remaining)
}

// The cache-ping countdown display, shared by the session statusline and the
// home overview. Both feed it the live pingAt the server publishes (the actual
// scheduled ping, cleared server-side the instant the daemon disarms), so the
// text always agrees. The fraction also depends on beforeExpiry, which each
// caller reads from its own config. A session with no scheduled ping (stopped,
// or window lapsed) yields null text + 0 fraction, so a stopped session shows
// "--" and an empty ring on both surfaces.
export function pingCountdown(pingAt: number | undefined, beforeExpiry: number, now: number) {
  const text = cacheCountdownUntil(pingAt, now)
  const window = CACHE_TTL - beforeExpiry
  const fraction = pingAt ? Math.max(0, Math.min(1, (pingAt - now) / window)) : 0
  return { text, fraction }
}

function format(remaining: number): string {
  const mins = Math.floor(remaining / 60000)
  const secs = Math.floor((remaining % 60000) / 1000)
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
}
