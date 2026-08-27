export namespace DictationRate {
  // Served when the sidecar cannot be reached at lookup time. Every current
  // model uses this rate, so it is also what the field runs on in practice.
  export const DEFAULT = 16000

  let cached: number | undefined

  // Cached for the server's run rather than fetched per connect: the rate only
  // changes when the model does, which the operator follows with a server
  // reload. A stale rate after an unreloaded model swap is caught by the
  // client-vs-sidecar check at transcribe time, not here.
  export async function get(url: string) {
    if (cached !== undefined) return cached
    const rate = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })
      .then((r) => (r.ok ? r.json() : undefined))
      .then((health) => (typeof health?.sampleRate === "number" ? health.sampleRate : undefined))
      .catch(() => undefined)
    cached = rate ?? DEFAULT
    return cached
  }
}
