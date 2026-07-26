import { lazy as solidLazy, type Component } from "solid-js"
import { Visibility } from "@/utils/visibility"

// Loading a code-split chunk over a flaky link has a failure mode plain retry
// cannot fix: the browser memoizes the *rejected* module record, so re-running
// the same specifier replays the cached failure forever, even once the network
// is healthy again. A failed <link rel=modulepreload> poisons the later import
// the same way. Only a different specifier (a query suffix) or a fresh document
// can recover — measured identically in Chromium and WebKit.
//
// Two tiers, because neither covers every engine alone. Chromium names the
// failed URL in the error, so a suffixed retry recovers in place with no lost
// state. WebKit reports only "Importing a module script failed." with no URL,
// in the rejection and in the vite:preloadError payload alike, so a targeted
// retry is impossible there and reload is the only cure — which is what the
// Vite docs prescribe for this case (guide/build, Load Error Handling).
//
// Note the docs' example calls reload() WITHOUT preventDefault(): preventing
// the default makes Vite's preload helper swallow the error and resolve the
// import with undefined, which turns a catchable failure into a null-deref on
// mod.default. Let it reject and handle it here instead.

const ATTEMPTS = 4
const DELAY = 400
const FACTOR = 2
const MAX_DELAY = 4000

// Reload is a last resort: it discards the unsubmitted prompt draft (in-memory
// by design). It is also the only cure for a stale build — /assets/* is
// content-hashed, so a tab holding a previous index.html asks for files no
// server still has, and no amount of retrying conjures them back.
const RELOADS = "opencode.chunk.reloads"
const RELOAD_LIMIT = 2
const RELOAD_WINDOW = 600_000

export type ChunkImport<T> = () => Promise<T>

// The server resolves /assets/* by path and ignores the query, so a suffixed
// retry still reaches the same file while presenting the module map with a
// specifier it has not already failed. The immutable year-long cache entry
// stays keyed to the clean URL, so this costs one uncached fetch, not a
// permanent duplicate.
function bust(url: string, attempt: number) {
  return url + (url.includes("?") ? "&" : "?") + "oc_retry=" + attempt
}

function extract(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.match(/https?:\/\/[^\s"')]+/)?.[0]
}

// navigator.onLine reports the link, not reachability, so a captive portal or a
// half-open wifi association still reads as online. Only a real round trip to
// the origin proves a retry has any chance, and it is also the guard against
// reloading into the browser's offline error page.
async function reachable() {
  try {
    await fetch(`${location.origin}/site.webmanifest?probe=${Date.now()}`, { cache: "no-store" })
    return true
  } catch {
    return false
  }
}

async function settle(count: number) {
  await Visibility.whenOnline()
  await new Promise((resolve) => setTimeout(resolve, Math.min(DELAY * FACTOR ** count, MAX_DELAY)))
}

// Seam for tests: the retry has to reach the module loader through a value the
// suite can substitute, since a literal import() cannot be exercised offline.
export const importer = {
  load: (specifier: string) => import(/* @vite-ignore */ specifier),
}

export async function loadChunk<T>(load: ChunkImport<T>): Promise<T> {
  let url: string | undefined
  let last: unknown

  for (let count = 0; count < ATTEMPTS; count++) {
    try {
      if (count === 0 || !url) return await load()
      return (await importer.load(bust(url, count))) as T
    } catch (error) {
      last = error
      url = url ?? extract(error)
      // Without a URL the specifier is poisoned beyond reach, so further
      // attempts would replay the same cached rejection and only add latency
      // before the reload that can actually fix it.
      if (!url) break
      if (count === ATTEMPTS - 1) break
      await settle(count)
    }
  }

  if (await reload()) return new Promise<T>(() => {})
  throw last
}

// Bounded rather than one-shot: a single reload permanently spent would strand
// a long-lived PWA tab across the next deploy, while unbounded reloads on a
// chunk that is simply gone would spin. Two per window recovers a stale build
// and self-heals after the window without ever looping.
async function reload() {
  if (typeof sessionStorage === "undefined" || typeof location === "undefined") return false
  if (!(await reachable())) return false

  try {
    const prior = JSON.parse(sessionStorage.getItem(RELOADS) ?? "null")
    const fresh = prior && Date.now() - prior.at < RELOAD_WINDOW ? prior.count : 0
    if (fresh >= RELOAD_LIMIT) return false
    sessionStorage.setItem(RELOADS, JSON.stringify({ count: fresh + 1, at: Date.now() }))
  } catch {
    return false
  }

  location.reload()
  return true
}

// Drop-in for solid's lazy() that routes the import through the recovery path.
export function lazy<T extends Component<any>>(load: ChunkImport<{ default: T }>) {
  return solidLazy(() => loadChunk(load))
}
