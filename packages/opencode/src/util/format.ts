// A human duration ("30m", "1h30m", "1h 30m", "90s", "2h") to seconds. A bare
// number is taken as seconds, so a plain integer still works. Returns undefined
// for anything unparseable, letting the caller decide how to complain.
export function parseDuration(input: string | number): number | undefined {
  if (typeof input === "number") return Number.isFinite(input) ? input : undefined
  const text = input.trim()
  if (text === "") return undefined
  if (/^\d+$/.test(text)) return Number(text)
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }
  let total = 0
  let matched = false
  // Each segment is a count and a unit; whitespace between segments is allowed
  // so formatDuration's own output round-trips.
  for (const [, count, u] of text.matchAll(/(\d+)\s*([smhd])/g)) {
    total += Number(count) * unit[u as keyof typeof unit]
    matched = true
  }
  // The regex ignores stray characters, so reject anything left over: a leftover
  // means the input was not a clean duration and silently dropping it would hide
  // a typo like "30x".
  if (!matched || text.replace(/\d+\s*[smhd]\s*/g, "") !== "") return undefined
  return total
}

export function formatDuration(secs: number) {
  if (secs <= 0) return ""
  if (secs < 60) return `${secs}s`
  if (secs < 3600) {
    const mins = Math.floor(secs / 60)
    const remaining = secs % 60
    return remaining > 0 ? `${mins}m ${remaining}s` : `${mins}m`
  }
  if (secs < 86400) {
    const hours = Math.floor(secs / 3600)
    const remaining = Math.floor((secs % 3600) / 60)
    return remaining > 0 ? `${hours}h ${remaining}m` : `${hours}h`
  }
  if (secs < 604800) {
    const days = Math.floor(secs / 86400)
    return days === 1 ? "~1 day" : `~${days} days`
  }
  const weeks = Math.floor(secs / 604800)
  return weeks === 1 ? "~1 week" : `~${weeks} weeks`
}
