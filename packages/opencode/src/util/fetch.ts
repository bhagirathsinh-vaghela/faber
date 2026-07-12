const MAX_REDIRECTS = 10

const REDIRECT_STATUS = [301, 302, 303, 307, 308]

function sameHost(a: string, b: string) {
  return new URL(a).hostname.replace(/^www\./, "") === new URL(b).hostname.replace(/^www\./, "")
}

export type FetchResult =
  | { type: "response"; response: Response; url: string }
  | { type: "cross-host"; from: string; to: string; status: number; statusText: string }

// Follow redirects one hop at a time with redirect:"manual", re-checking the
// host on every hop. A single fetch with redirect:"follow" would let hop 2+
// walk to any host with no check; a first-hop-only check misses the same
// problem. Same-host hops are followed up to MAX_REDIRECTS; the first cross-host
// hop stops and is reported so the caller can decide (the model is asked to
// retry with the new URL rather than being silently sent off-host).
export async function fetchFollowingSameHost(
  url: string,
  init: RequestInit,
  depth = 0,
): Promise<FetchResult> {
  if (depth > MAX_REDIRECTS) throw new Error(`Too many redirects (>${MAX_REDIRECTS}) starting from ${url}`)

  const response = await fetch(url, { ...init, redirect: "manual" })
  if (!REDIRECT_STATUS.includes(response.status)) return { type: "response", response, url }

  const location = response.headers.get("location")
  if (!location) throw new Error(`Redirect from ${url} missing Location header`)

  const next = new URL(location, url).toString()
  if (!sameHost(url, next))
    return { type: "cross-host", from: url, to: next, status: response.status, statusText: response.statusText }

  return fetchFollowingSameHost(next, init, depth + 1)
}
