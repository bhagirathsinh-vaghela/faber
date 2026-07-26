import { afterEach, describe, expect, test } from "bun:test"
import { importer, loadChunk } from "./chunk"

const real = importer.load

afterEach(() => {
  importer.load = real
})

// Mirrors the browser's module map: once a specifier rejects, that exact
// specifier keeps rejecting no matter how healthy the network becomes. Only a
// distinct specifier reaches the network again.
function browser(options: { failures: number; url?: string }) {
  const poisoned = new Set<string>()
  const requests: string[] = []
  let remaining = options.failures

  const fail = () =>
    new Error(
      options.url
        ? `Failed to fetch dynamically imported module: ${options.url}`
        : "Importing a module script failed.",
    )

  const load = (specifier: string) => {
    if (poisoned.has(specifier)) return Promise.reject(fail())
    requests.push(specifier)
    if (remaining > 0) {
      remaining--
      poisoned.add(specifier)
      return Promise.reject(fail())
    }
    return Promise.resolve({ default: "loaded" })
  }

  importer.load = load
  return { requests, load }
}

const URL = "http://localhost/assets/session-abc123.js"

describe("loadChunk", () => {
  test("returns the module when the first import succeeds", async () => {
    const engine = browser({ failures: 0, url: URL })
    expect(await loadChunk(() => engine.load(URL))).toEqual({ default: "loaded" })
    expect(engine.requests).toEqual([URL])
  })

  test("recovers from a transient failure with a suffixed specifier", async () => {
    const engine = browser({ failures: 1, url: URL })
    expect(await loadChunk(() => engine.load(URL))).toEqual({ default: "loaded" })
    expect(engine.requests).toEqual([URL, `${URL}?oc_retry=1`])
  })

  test("keeps retrying while failures persist, each with a fresh specifier", async () => {
    const engine = browser({ failures: 3, url: URL })
    expect(await loadChunk(() => engine.load(URL))).toEqual({ default: "loaded" })
    expect(engine.requests).toEqual([URL, `${URL}?oc_retry=1`, `${URL}?oc_retry=2`, `${URL}?oc_retry=3`])
  })

  test("gives up after the attempt budget and reports the last failure", async () => {
    const engine = browser({ failures: Infinity, url: URL })
    await expect(loadChunk(() => engine.load(URL))).rejects.toThrow("Failed to fetch dynamically imported module")
    expect(engine.requests).toEqual([URL, `${URL}?oc_retry=1`, `${URL}?oc_retry=2`, `${URL}?oc_retry=3`])
  })

  test("stops after one attempt when the engine hides the url", async () => {
    const engine = browser({ failures: Infinity })
    await expect(loadChunk(() => engine.load(URL))).rejects.toThrow("Importing a module script failed.")
    // Retrying an unknown specifier can only replay the poisoned entry, so the
    // budget is spent on reload instead of pointless refetches.
    expect(engine.requests).toEqual([URL])
  })

  test("preserves an existing query string when suffixing", async () => {
    const versioned = `${URL}?v=2`
    const engine = browser({ failures: 1, url: versioned })
    expect(await loadChunk(() => engine.load(versioned))).toEqual({ default: "loaded" })
    expect(engine.requests).toEqual([versioned, `${versioned}&oc_retry=1`])
  })
})
