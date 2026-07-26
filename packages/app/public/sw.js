// Makes the app survive a flaky link. Everything under /assets/ is content
// hashed by Vite and served immutable, so a given URL's bytes can never change:
// once a chunk is in the cache it is valid forever and can be served without
// the network. That turns the worst failure mode — a dynamic import() losing a
// race with a dropped connection, which the browser then memoizes as a
// permanently rejected module — into a cache hit.
//
// It deliberately does NOT cache navigations or any API traffic. index.html is
// no-cache so a rebuilt UI is picked up, and serving a stale shell offline
// would only produce a broken app pointed at an unreachable server.

const CACHE = "opencode-assets-v1"

// Same-origin /assets/* only: those are the immutable, content-addressed files.
function cacheable(request) {
  if (request.method !== "GET") return false
  const url = new URL(request.url)
  return url.origin === self.location.origin && url.pathname.startsWith("/assets/")
}

// The retry path in utils/chunk appends oc_retry to force a fresh module
// specifier past the browser's poisoned module map. That is a different URL but
// the same underlying file, so it must hit the same cache entry rather than
// miss and go to the network — which is exactly what a retry cannot rely on.
function key(request) {
  const url = new URL(request.url)
  url.search = ""
  return new Request(url.toString(), { credentials: "same-origin" })
}

function shell(html) {
  return [...html.matchAll(/["'](\/assets\/[^"']+)["']/g)].map((match) => match[1])
}

function index() {
  return fetch("/index.html", { cache: "reload" }).then((response) => response.text())
}

// A worker does not control the page that registered it, so the shell would
// otherwise only be cached from the second visit on. Caching it at install time
// is what lets a reload boot with no network — the recovery path that matters,
// since WebKit reports no chunk URL and cannot retry a poisoned import at all.
//
// Shell only, deliberately. The entry references ~31MB once fonts and syntax
// grammars are counted, and pulling that on install would batter the very
// connection this exists to survive. Route chunks land in the cache the first
// time they are actually fetched.
async function precache() {
  const cache = await caches.open(CACHE)
  const assets = shell(await index())
  // Best-effort: a chunk that fails here is simply fetched later, so one bad
  // response must not reject install and leave the worker unregistered.
  await Promise.allSettled(assets.map((asset) => cache.add(new Request(asset, { credentials: "same-origin" }))))
}

// Hashed filenames mean a rebuilt UI never overwrites an entry, it only adds
// one, so without a sweep the cache grows by a full asset set per deploy. The
// current shell is the anchor: anything unreachable from it belongs to a build
// nothing can request anymore. Lazy route chunks are not named in index.html,
// so this only fires once the stale set is far larger than one build's worth —
// bounded growth, not exact collection.
async function sweep() {
  const cache = await caches.open(CACHE)
  const live = new Set(shell(await index()))
  const stale = (await cache.keys()).filter((request) => !live.has(new URL(request.url).pathname))
  if (stale.length < 400) return
  await Promise.all(stale.map((request) => cache.delete(request)))
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().finally(() => self.skipWaiting()))
})

self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)))
      await self.clients.claim()
      await sweep().catch(() => undefined)
    })(),
  ),
)

self.addEventListener("fetch", (event) => {
  if (!cacheable(event.request)) return

  // The write is deliberately NOT awaited before responding, but it is handed
  // to waitUntil so the worker stays alive until it lands. Awaiting it would
  // delay every cold asset, and dropping it would lose the entry whenever the
  // worker is killed right after the response — which is exactly how a chunk
  // ends up uncached until the second visit.
  const store = async (response) => {
    // Only 200s are worth keeping: a 404 here means a stale build asking for a
    // hash that no longer exists, and caching that would make the miss
    // permanent instead of letting a reload pick up the new shell.
    if (!response.ok) return
    const cache = await caches.open(CACHE)
    await cache.put(key(event.request), response)
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE)
      const cached = await cache.match(key(event.request))
      if (cached) return cached

      const response = await fetch(event.request)
      event.waitUntil(store(response.clone()))
      return response
    })(),
  )
})
