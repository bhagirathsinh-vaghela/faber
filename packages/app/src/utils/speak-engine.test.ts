import { beforeEach, describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createSpeech } from "./speak"

// There is no audio device under test, so the element is a stand-in that keeps
// the two behaviours the engine depends on: a src load resets playbackRate to
// defaultPlaybackRate, and pause() rejects a pending play() with AbortError.
class FakeAudio {
  #src = ""
  paused = true
  ended = false
  playbackRate = 1
  defaultPlaybackRate = 1
  preservesPitch = false
  played: string[] = []
  pending?: { resolve: () => void; reject: (error: Error) => void }
  onended: (() => void) | null = null
  onpause: (() => void) | null = null
  onplay: (() => void) | null = null
  onerror: (() => void) | null = null
  onloadedmetadata: (() => void) | null = null

  get src() {
    return this.#src
  }
  set src(value: string) {
    this.#src = value
    this.playbackRate = this.defaultPlaybackRate
    this.ended = false
    this.paused = true
    this.abort()
  }
  abort() {
    this.pending?.reject(new DOMException("interrupted", "AbortError"))
    this.pending = undefined
  }
  play() {
    this.played.push(this.#src)
    this.paused = false
    return new Promise<void>((resolve, reject) => {
      this.pending = { resolve, reject }
    })
  }
  started() {
    this.pending?.resolve()
    this.pending = undefined
  }
  pause() {
    this.abort()
    if (this.paused) return
    this.paused = true
    this.onpause?.()
  }
  finish() {
    this.paused = true
    this.ended = true
    this.onpause?.()
    this.onended?.()
  }
  removeAttribute() {
    this.src = ""
  }
  load() {}
}

type Render = {
  text: string
  priority: string
  session: string
  signal: AbortSignal
  answered: boolean
  // Whether a live request for the same text was still open when this one was
  // sent, which is what lets the sidecar join the two rather than start over.
  joined: boolean
  resolve: (response: Response) => void
}

const encoder = new TextEncoder()

// One per /tts/prepare request, each with its own stream, so a test can feed a
// superseded reading's stream after a newer one has started.
function stream(body: { text: string; sessionID: string }, headers: Headers, signal: AbortSignal) {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const state = { cancelled: false }
  const readable = new ReadableStream<Uint8Array>({
    start: (c) => void (controller = c),
    cancel: () => void (state.cancelled = true),
  })
  return {
    body,
    headers,
    signal,
    readable,
    cancelled: () => state.cancelled,
    send: (...lines: object[]) =>
      controller.enqueue(encoder.encode(lines.map((line) => JSON.stringify(line) + "\n").join(""))),
    raw: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  }
}

function server() {
  const renders: Render[] = []
  const prepares: ReturnType<typeof stream>[] = []
  const dones: string[] = []
  const live = () => renders.filter((r) => !r.signal.aborted && !r.answered)
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    if (url.endsWith("/tts/done")) {
      dones.push(headers.get("x-speech-session") ?? "")
      return new Response(null, { status: 204 })
    }
    if (url.endsWith("/tts/prepare")) {
      const prepare = stream(JSON.parse(String(init?.body)), headers, init!.signal!)
      prepares.push(prepare)
      return new Response(prepare.readable, { status: 200, headers: { "content-type": "application/x-ndjson" } })
    }
    const body = JSON.parse(String(init?.body)) as { text: string; priority: string }
    return new Promise<Response>((resolve, reject) => {
      const signal = init!.signal!
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
      const joined = live().some((r) => r.text === body.text)
      renders.push({
        ...body,
        session: headers.get("x-speech-session") ?? "",
        signal,
        answered: false,
        joined,
        resolve,
      })
    })
  }) as typeof globalThis.fetch

  return {
    fetch,
    renders,
    prepares,
    dones,
    send: (...lines: object[]) => prepares.at(-1)!.send(...lines),
    raw: (text: string) => prepares.at(-1)!.raw(text),
    end: () => prepares.at(-1)!.end(),
    // Answers the newest live request for this text with audio carrying it.
    render: (text: string) => {
      const found = renders.findLast((r) => r.text === text && !r.signal.aborted && !r.answered)
      if (!found) throw new Error(`no live render for ${text}`)
      found.answered = true
      found.resolve(new Response(new Blob([text], { type: "audio/wav" })))
    },
    refuse: (text: string, status: number, reason: string) => {
      const found = renders.findLast((r) => r.text === text && !r.signal.aborted && !r.answered)
      if (!found) throw new Error(`no live render for ${text}`)
      found.answered = true
      found.resolve(new Response(reason, { status }))
    },
    live: () => live().map((r) => [r.text, r.priority]),
  }
}

const turn = () => new Promise((resolve) => setImmediate(resolve))

// Yields to the timer queue until the check holds, so a test waits exactly as
// long as the engine's debounce and promise chain take rather than a guessed
// interval.
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("the condition never held")
}

let parts = 0
const key = () => `prt_${++parts}`

function setup(timeout?: { foreground: number; background: number }, backoff = 1_000_000, debounce = 0) {
  const backend = server()
  const audio = new FakeAudio()
  const errors: string[] = []
  // Object URLs stand in for the rendered audio, so each maps back to the text
  // it voices and a test can say which chunk the element holds.
  const voiced = new Map<string, Blob>()
  let minted = 0
  const root = createRoot((dispose) => ({
    dispose,
    speech: createSpeech({
      url: () => "http://server",
      session: () => "ses_1",
      directory: () => "/work/dir",
      fetch: backend.fetch,
      audio: () => audio as unknown as HTMLAudioElement,
      objects: {
        create: (blob) => {
          const url = `blob:test/${++minted}`
          voiced.set(url, blob)
          return url
        },
        revoke: (url) => void voiced.delete(url),
      },
      debounce,
      timeout,
      backoff,
      onError: (message) => errors.push(message),
    }),
  }))
  const speech = root.speech
  // Everything a test can observe, so the engine counts as settled once none of
  // it has moved for a few turns.
  const probe = () =>
    JSON.stringify([
      backend.renders.map((r) => [r.text, r.priority, r.signal.aborted, r.answered]),
      backend.prepares.length,
      backend.dones,
      errors,
      audio.src,
      audio.played.length,
      speech.index(),
      speech.total(),
      speech.loading(),
      speech.speaking(),
      speech.open(),
    ])
  const flush = async () => {
    let last = probe()
    let calm = 0
    for (let i = 0; i < 500 && calm < 3; i++) {
      await turn()
      const now = probe()
      calm = now === last ? calm + 1 : 0
      last = now
    }
    if (calm < 3) throw new Error("the engine never settled")
  }
  const holding = () => voiced.get(audio.src)?.text()
  return { ...backend, audio, errors, speech, flush, holding, voiced, dispose: root.dispose }
}

const chunks = (...texts: string[]) => [
  ...texts.map((text, index) => ({ type: "chunk", index, text })),
  { type: "done", total: texts.length },
]

beforeEach(() => {
  window.localStorage.clear()
})

describe("createSpeech", () => {
  test("the prepare request carries the text, session, directory, and a per-reading listener id", async () => {
    const it = setup()
    it.speech.show(key(), "Some **markdown**.")
    await it.flush()
    expect(it.prepares.length).toBe(1)
    expect(it.prepares[0]!.body).toEqual({ text: "Some **markdown**.", sessionID: "ses_1" })
    expect(it.prepares[0]!.headers.get("x-opencode-directory")).toBe("%2Fwork%2Fdir")
    expect(it.prepares[0]!.headers.get("x-speech-session")).toMatch(/^[a-z0-9]+:\d+$/)
    it.dispose()
  })

  test("a reading the server sent as written is asked for again on the next showing", async () => {
    const it = setup()
    const a = key()
    it.speech.show(a, "A")
    it.send({ type: "chunk", index: 0, text: "A." }, { type: "done", total: 1, written: true })
    await it.flush()
    it.speech.close()
    it.speech.show(a, "A")
    await it.flush()
    expect(it.prepares.length).toBe(2)
    it.dispose()
  })

  test("each reading sends its own session id on prepare, speak, and done", async () => {
    const it = setup()
    const a = key()
    it.speech.show(a, "A")
    it.send(...chunks("a0"))
    await it.flush()
    const first = it.prepares[0]!.headers.get("x-speech-session")!
    expect(it.renders.map((r) => r.session)).toEqual([first])

    it.speech.show(key(), "B")
    expect(it.dones).toEqual([first])
    const second = it.prepares[1]!.headers.get("x-speech-session")!
    expect(second).not.toBe(first)
    expect(second.split(":")[0]).toBe(first.split(":")[0])
    it.send(...chunks("b0"))
    await it.flush()
    expect(it.renders.map((r) => [r.text, r.session])).toEqual([
      ["a0", first],
      ["b0", second],
    ])

    // A held reading shown again is a new showing: the done already sent for
    // its last one must not reach what it requests now.
    it.speech.show(a, "A")
    expect(it.dones).toEqual([first, second])
    await it.flush()
    const third = it.renders.at(-1)!
    expect(third.text).toBe("a0")
    expect([first, second]).not.toContain(third.session)
    it.speech.close()
    expect(it.dones).toEqual([first, second, third.session])
    it.dispose()
  })

  test("chunk 0 is requested now as soon as it streams in, and plays when it lands", async () => {
    const it = setup()
    it.speech.show(key(), "text")
    expect(it.speech.speaking()).toBe(true)
    expect(it.speech.loading()).toBe(true)
    it.send({ type: "chunk", index: 0, text: "first" })
    await it.flush()
    expect(it.live()).toEqual([["first", "now"]])
    it.render("first")
    await it.flush()
    expect(await it.holding()).toBe("first")
    expect(it.speech.loading()).toBe(false)
    expect(it.speech.chunk()).toBe("first")
    it.dispose()
  })

  test("blank heartbeat lines in the prepare stream are ignored", async () => {
    const it = setup()
    it.speech.show(key(), "text")
    it.raw("\n")
    it.send({ type: "chunk", index: 0, text: "c0" })
    it.raw("\n\n   \n")
    it.send({ type: "chunk", index: 1, text: "c1" }, { type: "done", total: 2 })
    await it.flush()
    expect(it.errors).toEqual([])
    expect(it.speech.total()).toBe(2)
    expect(it.live()).toEqual([
      ["c0", "now"],
      ["c1", "next"],
    ])
    it.dispose()
  })

  test("the scheduler asks for the cursor now, the next one next, and one background render at a time", async () => {
    const it = setup()
    it.speech.show(key(), "text")
    it.send(...chunks("c0", "c1", "c2", "c3"))
    await it.flush()
    expect(it.live()).toEqual([
      ["c0", "now"],
      ["c1", "next"],
      ["c2", "background"],
    ])
    it.render("c2")
    await it.flush()
    expect(it.live()).toEqual([
      ["c0", "now"],
      ["c1", "next"],
      ["c3", "background"],
    ])
    it.dispose()
  })

  test("pressing another part never plays the first part's chunks or position", async () => {
    const it = setup()
    const a = key()
    it.speech.show(a, "A")
    it.send(...chunks("a0", "a1", "a2"))
    await it.flush()
    it.render("a0")
    it.render("a1")
    await it.flush()
    it.audio.started()
    it.audio.finish()
    await it.flush()
    expect(it.speech.index()).toBe(1)
    const stale = it.renders.filter((r) => r.text.startsWith("a") && !r.answered && !r.signal.aborted)
    expect(stale.map((r) => [r.text, r.priority])).toEqual([["a2", "next"]])

    it.speech.show(key(), "B")
    expect(stale[0]!.signal.aborted).toBe(true)
    expect(it.speech.index()).toBe(0)
    expect(it.speech.total()).toBe(0)
    expect(it.speech.chunk()).toBe("")
    expect(it.speech.speaking()).toBe(true)
    expect(it.speech.loading()).toBe(true)

    it.send(...chunks("b0", "b1"))
    await it.flush()
    expect(it.live().map(([text]) => text)).toEqual(["b0", "b1"])
    it.render("b0")
    await it.flush()
    expect(await it.holding()).toBe("b0")
    expect(it.speech.total()).toBe(2)
    expect(it.dones.length).toBe(1)
    it.dispose()
  })

  test("pressing another part while the first is still streaming drops the first's late lines", async () => {
    const it = setup()
    it.speech.show(key(), "A")
    it.send({ type: "chunk", index: 0, text: "a0" })
    await it.flush()
    expect(it.live()).toEqual([["a0", "now"]])

    it.speech.show(key(), "B")
    expect(it.prepares[0]!.signal.aborted).toBe(true)
    it.prepares[0]!.send({ type: "chunk", index: 1, text: "a1" }, { type: "done", total: 2 })
    it.prepares[1]!.send(...chunks("b0"))
    await it.flush()
    expect(it.live()).toEqual([["b0", "now"]])
    expect(it.renders.map((r) => r.text)).toEqual(["a0", "b0"])
    expect(it.speech.total()).toBe(1)
    it.render("b0")
    await it.flush()
    expect(await it.holding()).toBe("b0")
    expect(it.errors).toEqual([])
    it.dispose()
  })

  test("returning to a part left partway opens the HUD armed at that chunk", async () => {
    const it = setup()
    const a = key()
    it.speech.show(a, "A")
    it.send(...chunks("a0", "a1", "a2"))
    await it.flush()
    it.render("a0")
    it.render("a1")
    await it.flush()
    it.audio.finish()
    await it.flush()
    it.speech.show(key(), "B")
    it.speech.show(a, "A")
    expect(it.speech.armed()).toBe(true)
    expect(it.speech.speaking()).toBe(false)
    expect(it.speech.index()).toBe(1)
    expect(it.speech.chunk()).toBe("a1")
    expect(it.prepares.length).toBe(2)
    it.dispose()
  })

  test("two parts keep independent positions", async () => {
    const it = setup()
    const a = key()
    const b = key()
    it.speech.show(a, "A")
    it.send(...chunks("a0", "a1", "a2"))
    await it.flush()
    it.speech.seek(2)
    it.speech.show(b, "B")
    it.send(...chunks("b0", "b1", "b2"))
    await it.flush()
    it.speech.seek(1)

    it.speech.show(a, "A")
    expect(it.speech.index()).toBe(2)
    expect(it.speech.chunk()).toBe("a2")
    it.speech.show(b, "B")
    expect(it.speech.index()).toBe(1)
    expect(it.speech.chunk()).toBe("b1")
    expect(it.prepares.length).toBe(2)
    it.dispose()
  })

  test("a part heard to the end plays again from the start, from audio already held", async () => {
    const it = setup()
    const a = key()
    it.speech.show(a, "A")
    it.send(...chunks("a0", "a1"))
    await it.flush()
    it.render("a0")
    it.render("a1")
    await it.flush()
    it.audio.finish()
    it.audio.finish()
    expect(it.speech.open()).toBe(false)

    const requested = it.renders.length
    it.speech.show(a, "A")
    expect(it.speech.speaking()).toBe(true)
    expect(it.speech.armed()).toBe(false)
    expect(it.speech.index()).toBe(0)
    expect(await it.holding()).toBe("a0")
    expect(it.renders.length).toBe(requested)
    expect(it.prepares.length).toBe(1)
    it.dispose()
  })

  test("playing past the last chunk before the stream finishes ends the reading when it does", async () => {
    const it = setup()
    const a = key()
    it.speech.show(a, "A")
    it.send({ type: "chunk", index: 0, text: "a0" })
    await it.flush()
    it.render("a0")
    await it.flush()
    it.audio.finish()
    expect(it.speech.speaking()).toBe(true)
    expect(it.speech.index()).toBe(1)
    expect(it.speech.loading()).toBe(true)

    it.send({ type: "done", total: 1 })
    await it.flush()
    expect(it.speech.open()).toBe(false)
    expect(it.speech.index()).toBe(0)
    expect(it.dones.length).toBe(1)
    expect(it.errors).toEqual([])

    it.speech.show(a, "A")
    expect(it.speech.speaking()).toBe(true)
    expect(it.speech.index()).toBe(0)
    expect(await it.holding()).toBe("a0")
    it.dispose()
  })

  test("a rewrite that produces no chunks is reported rather than closing silently", async () => {
    const it = setup()
    it.speech.show(key(), "A")
    it.send({ type: "done", total: 0 })
    await it.flush()
    expect(it.errors).toEqual(["Preparing the speech failed: the rewrite produced nothing to read"])
    expect(it.speech.open()).toBe(false)
    expect(it.dones.length).toBe(1)
    it.dispose()
  })

  test("the speed survives the src swap into the next chunk", async () => {
    const it = setup()
    it.speech.faster()
    it.speech.faster()
    it.speech.show(key(), "A")
    it.send(...chunks("a0", "a1"))
    await it.flush()
    it.render("a0")
    it.render("a1")
    await it.flush()
    expect(it.speech.rate()).toBe(1.2)
    expect(it.audio.playbackRate).toBe(1.2)
    it.audio.finish()
    expect(await it.holding()).toBe("a1")
    expect(it.audio.defaultPlaybackRate).toBe(1.2)
    expect(it.audio.playbackRate).toBe(1.2)
    it.dispose()
  })

  test("the speed steps by tenths and stops at each end of its range", () => {
    const it = setup()
    for (let i = 0; i < 30; i++) it.speech.faster()
    expect(it.speech.rate()).toBe(2.5)
    for (let i = 0; i < 7; i++) it.speech.slower()
    expect(it.speech.rate()).toBe(1.8)
    for (let i = 0; i < 30; i++) it.speech.slower()
    expect(it.speech.rate()).toBe(0.5)
    it.dispose()
  })

  test("pausing while the next chunk loads keeps it from starting when it lands", async () => {
    const it = setup()
    it.speech.show(key(), "A")
    it.send(...chunks("a0", "a1"))
    await it.flush()
    it.render("a0")
    await it.flush()
    it.audio.finish()
    expect(it.speech.loading()).toBe(true)
    it.speech.pause()
    it.render("a1")
    await it.flush()
    expect(it.audio.played.length).toBe(2)
    expect(it.speech.paused()).toBe(true)

    it.speech.resume()
    expect(await it.holding()).toBe("a1")
    expect(it.audio.played.length).toBe(3)
    it.dispose()
  })

  test("pausing while play() is still pending is not an error, and resuming plays the same chunk", async () => {
    const it = setup()
    it.speech.show(key(), "A")
    it.send(...chunks("a0"))
    await it.flush()
    it.render("a0")
    await it.flush()
    const src = it.audio.src
    it.speech.pause()
    await it.flush()
    expect(it.errors).toEqual([])
    expect(it.speech.speaking()).toBe(true)
    expect(it.speech.paused()).toBe(true)
    expect(it.audio.paused).toBe(true)

    it.speech.resume()
    expect(it.speech.paused()).toBe(false)
    expect(it.audio.paused).toBe(false)
    expect(it.audio.played.at(-1)).toBe(src)
    expect(await it.holding()).toBe("a0")
    it.dispose()
  })

  test("a pause from outside the HUD is reflected in it", async () => {
    const it = setup()
    it.speech.show(key(), "A")
    it.send(...chunks("a0"))
    await it.flush()
    it.render("a0")
    await it.flush()
    it.audio.started()
    it.audio.pause()
    expect(it.speech.paused()).toBe(true)
    it.dispose()
  })

  test("an error line from prepare is reported and nothing plays", async () => {
    const it = setup()
    it.speech.show(key(), "A")
    it.send({ type: "error", message: "rewrite model unavailable" })
    await it.flush()
    expect(it.errors).toEqual(["Preparing the speech failed: rewrite model unavailable"])
    expect(it.speech.open()).toBe(false)
    expect(it.renders.length).toBe(0)
    it.dispose()
  })

  test("a stream that ends without a terminal line is an error", async () => {
    const it = setup()
    it.speech.show(key(), "A")
    it.send({ type: "chunk", index: 0, text: "a0" })
    it.end()
    await it.flush()
    expect(it.errors).toEqual(["Preparing the speech failed: the stream ended before the server finished"])
    expect(it.speech.open()).toBe(false)
    it.dispose()
  })

  test("an unreadable line is an error", async () => {
    const it = setup()
    it.speech.show(key(), "A")
    it.raw("not json\n")
    await it.flush()
    expect(it.errors).toEqual(["Preparing the speech failed: unreadable line from the server: not json"])
    it.dispose()
  })

  test("a cancelled render reports the cause the server gave and stops the reading", async () => {
    const it = setup()
    it.speech.show(key(), "A")
    it.send(...chunks("a0"))
    await it.flush()
    it.renders[0]!.answered = true
    it.renders[0]!.resolve(new Response("render cancelled: the sidecar restarted", { status: 503 }))
    await it.flush()
    expect(it.errors).toEqual(["Speech for part 1 of 1 failed: 503 render cancelled: the sidecar restarted"])
    expect(it.speech.speaking()).toBe(false)
    expect(it.speech.armed()).toBe(true)
    it.dispose()
  })

  test("seeking to a chunk already rendered plays it without fetching it again", async () => {
    const it = setup()
    it.speech.show(key(), "A")
    it.send(...chunks("a0", "a1", "a2"))
    await it.flush()
    it.render("a0")
    it.render("a1")
    it.render("a2")
    await it.flush()
    it.audio.finish()
    expect(await it.holding()).toBe("a1")

    it.speech.seek(0)
    expect(it.speech.speaking()).toBe(false)
    expect(it.speech.index()).toBe(0)
    expect(it.speech.chunk()).toBe("a0")
    it.speech.start()
    expect(await it.holding()).toBe("a0")
    expect(it.renders.filter((r) => r.text === "a0").length).toBe(1)
    it.dispose()
  })

  test("seeking to the chunk already under the cursor does not stop it", async () => {
    const it = setup()
    it.speech.show(key(), "A")
    it.send(...chunks("a0", "a1"))
    await it.flush()
    it.render("a0")
    await it.flush()
    const played = it.audio.played.length
    it.speech.seek(0)
    expect(it.speech.speaking()).toBe(true)
    expect(it.speech.armed()).toBe(false)
    expect(it.audio.played.length).toBe(played)
    expect(await it.holding()).toBe("a0")
    it.dispose()
  })

  test("seeking clamps to the reading, and previous at the start stays there", async () => {
    const it = setup()
    it.speech.show(key(), "A")
    it.send(...chunks("a0", "a1", "a2"))
    await it.flush()
    it.speech.previous()
    expect(it.speech.index()).toBe(0)
    it.speech.seek(999)
    expect(it.speech.index()).toBe(2)
    expect(it.speech.chunk()).toBe("a2")
    it.speech.seek(-5)
    expect(it.speech.index()).toBe(0)
    it.dispose()
  })

  test("returning to the start clears the resume offer", async () => {
    const it = setup()
    it.speech.show(key(), "A")
    it.send(...chunks("a0", "a1", "a2"))
    await it.flush()
    it.speech.seek(2)
    expect(it.speech.resuming()).toBe(true)
    it.speech.restart()
    expect(it.speech.index()).toBe(0)
    expect(it.speech.resuming()).toBe(false)
    it.dispose()
  })

  test("a seek to an unrendered chunk moves its request to now once the presses settle", async () => {
    const it = setup()
    it.speech.show(key(), "A")
    it.send(...chunks("c0", "c1", "c2", "c3", "c4", "c5"))
    await it.flush()
    expect(it.live()).toEqual([
      ["c0", "now"],
      ["c1", "next"],
      ["c2", "background"],
    ])
    const background = it.renders.find((r) => r.text === "c2")!

    it.speech.seek(4)
    expect(it.speech.index()).toBe(4)
    expect(it.live()).toEqual([
      ["c0", "now"],
      ["c1", "next"],
      ["c2", "background"],
    ])
    await until(() => it.renders.some((r) => r.text === "c4"))
    await it.flush()
    expect(it.live()).toEqual([
      ["c2", "background"],
      ["c4", "now"],
      ["c5", "next"],
      ["c0", "background"],
    ])
    expect(background.signal.aborted).toBe(false)
    expect(it.renders.find((r) => r.text === "c1")!.signal.aborted).toBe(true)
    expect(it.renders.filter((r) => r.text === "c0").map((r) => r.joined)).toEqual([false, true])
    expect(it.errors).toEqual([])
    it.dispose()
  })

  test("audio landing while skip presses settle plans nothing until they settle", async () => {
    const it = setup(undefined, undefined, 60_000)
    it.speech.show(key(), "A")
    it.send(...chunks("c0", "c1", "c2", "c3", "c4", "c5"))
    await it.flush()

    it.speech.seek(3)
    it.speech.seek(4)
    it.render("c2")
    await it.flush()
    expect(it.speech.index()).toBe(4)
    expect(it.live()).toEqual([
      ["c0", "now"],
      ["c1", "next"],
    ])
    expect(it.renders.map((r) => r.text)).toEqual(["c0", "c1", "c2"])

    it.speech.start()
    await it.flush()
    expect(it.live()).toEqual([
      ["c4", "now"],
      ["c5", "next"],
      ["c0", "background"],
      ["c1", "background"],
    ])
    expect(it.errors).toEqual([])
    it.dispose()
  })

  test("a second seek moves the first seek's now request down and keeps one stranded render, the newest", async () => {
    const it = setup()
    it.speech.show(key(), "A")
    it.send(...chunks("c0", "c1", "c2", "c3", "c4", "c5"))
    await it.flush()

    it.speech.seek(5)
    await until(() => it.renders.some((r) => r.text === "c5"))
    await it.flush()
    expect(it.live()).toEqual([
      ["c2", "background"],
      ["c5", "now"],
      ["c0", "background"],
    ])

    it.speech.seek(3)
    await until(() => it.renders.some((r) => r.text === "c3"))
    await it.flush()
    expect(it.live()).toEqual([
      ["c0", "background"],
      ["c3", "now"],
      ["c4", "next"],
      ["c5", "background"],
    ])
    expect(it.renders.map((r) => [r.text, r.priority, r.signal.aborted])).toEqual([
      ["c0", "now", true],
      ["c1", "next", true],
      ["c2", "background", true],
      ["c5", "now", true],
      ["c0", "background", false],
      ["c3", "now", false],
      ["c4", "next", false],
      ["c5", "background", false],
    ])
    expect(it.errors).toEqual([])
    it.dispose()
  })

  test("a seek onto a chunk queued in the background raises it to now before dropping the old request", async () => {
    const it = setup()
    it.speech.show(key(), "A")
    it.send(...chunks("c0", "c1", "c2", "c3"))
    await it.flush()
    const background = it.renders.find((r) => r.text === "c2")!
    expect(background.priority).toBe("background")

    it.speech.seek(2)
    await until(() => background.signal.aborted)
    await it.flush()
    expect(it.live()).toEqual([
      ["c2", "now"],
      ["c3", "next"],
      ["c0", "background"],
      ["c1", "background"],
    ])
    const raised = it.renders.findLast((r) => r.text === "c2")!
    expect(raised.priority).toBe("now")
    expect(raised.joined).toBe(true)
    it.render("c2")
    it.speech.start()
    await it.flush()
    expect(await it.holding()).toBe("c2")
    expect(it.live()).toEqual([
      ["c3", "next"],
      ["c0", "background"],
      ["c1", "background"],
    ])
    expect(it.renders.filter((r) => r.text === "c2").length).toBe(2)
    expect(it.errors).toEqual([])
    it.dispose()
  })

  test("closing sends done once, however many times it is asked, and clears the chunk text", async () => {
    const it = setup()
    it.speech.show(key(), "A")
    it.send(...chunks("a0"))
    await it.flush()
    expect(it.speech.chunk()).toBe("a0")
    it.speech.close()
    it.speech.close()
    expect(it.dones.length).toBe(1)
    expect(it.speech.open()).toBe(false)
    expect(it.speech.chunk()).toBe("")
    expect(it.speech.chunks()).toEqual([])
    expect(it.renders.every((r) => r.signal.aborted)).toBe(true)
    it.dispose()
  })

  test("chunks lists every chunk received so far, with the cursor's chunk at index", async () => {
    const it = setup()
    it.speech.show(key(), "A")
    expect(it.speech.chunks()).toEqual([])
    it.send({ type: "chunk", index: 0, text: "a0" })
    await it.flush()
    expect(it.speech.chunks()).toEqual(["a0"])
    const first = it.speech.chunks()
    it.send({ type: "chunk", index: 1, text: "a1" }, { type: "chunk", index: 2, text: "a2" })
    await it.flush()
    expect(it.speech.chunks()).toEqual(["a0", "a1", "a2"])
    // A new array each time: the browser build of the store sees an array it
    // already holds, pushed to in place, as no change, and the transcript
    // would never grow.
    expect(it.speech.chunks()).not.toBe(first)
    it.speech.seek(2)
    await it.flush()
    expect(it.speech.chunks()[it.speech.index()]).toBe(it.speech.chunk())
    expect(it.speech.chunk()).toBe("a2")
    it.dispose()
  })

  test("a voice change drops rendered audio and fetches from the cursor again", async () => {
    const it = setup()
    it.speech.show(key(), "A")
    it.send(...chunks("a0", "a1", "a2"))
    await it.flush()
    it.render("a1")
    it.render("a2")
    await it.flush()
    expect(it.live()).toEqual([["a0", "now"]])
    it.speech.revoice()
    expect(it.live()).toEqual([
      ["a0", "now"],
      ["a1", "next"],
      ["a2", "background"],
    ])
    it.dispose()
  })

  test("a voice change while speaking leaves the playing chunk alone and fetches the next first", async () => {
    const it = setup()
    it.speech.show(key(), "A")
    it.send(...chunks("a0", "a1", "a2"))
    await it.flush()
    it.render("a0")
    it.render("a1")
    it.render("a2")
    await it.flush()
    expect(it.live()).toEqual([])
    const src = it.audio.src

    it.speech.revoice()
    expect(it.live()).toEqual([
      ["a1", "next"],
      ["a2", "background"],
    ])
    expect(it.audio.src).toBe(src)
    expect(await it.holding()).toBe("a0")
    it.dispose()
  })

  test("the prepare stream is released once its terminal line arrives", async () => {
    const it = setup()
    it.speech.show(key(), "A")
    it.send(...chunks("a0"))
    await it.flush()
    expect(it.prepares[0]!.cancelled()).toBe(true)
    expect(it.prepares[0]!.signal.aborted).toBe(false)
    expect(it.errors).toEqual([])
    it.dispose()
  })

  test("a resume the element refuses is reported and leaves the reading paused", async () => {
    const it = setup()
    it.speech.show(key(), "A")
    it.send(...chunks("a0"))
    await it.flush()
    it.render("a0")
    await it.flush()
    it.audio.started()
    it.speech.pause()
    it.speech.resume()
    expect(it.speech.paused()).toBe(false)
    it.audio.pending!.reject(new Error("playback blocked"))
    await it.flush()
    expect(it.errors).toEqual(["Playback failed: playback blocked"])
    expect(it.speech.speaking()).toBe(true)
    expect(it.speech.paused()).toBe(true)
    it.dispose()
  })

  test("a render for the cursor that never answers stops the reading and names the chunk", async () => {
    const it = setup({ foreground: 20, background: 1_000_000 })
    it.speech.show(key(), "A")
    it.send(...chunks("a0", "a1", "a2"))
    await it.flush()
    expect(it.live()).toEqual([
      ["a0", "now"],
      ["a1", "next"],
      ["a2", "background"],
    ])
    await new Promise((resolve) => setTimeout(resolve, 40))
    await it.flush()
    expect(it.errors).toEqual(["Speech for part 1 of 3 failed: no audio for part 1 after 0.02s"])
    expect(it.live()).toEqual([])
    expect(it.speech.speaking()).toBe(false)
    expect(it.speech.armed()).toBe(true)
    it.dispose()
  })

  test("a background render that never answers is dropped silently and asked for again after the backoff", async () => {
    const it = setup({ foreground: 1_000_000, background: 20 }, 10)
    it.speech.show(key(), "A")
    it.send(...chunks("c0", "c1", "c2", "c3"))
    await it.flush()
    const first = it.renders.find((r) => r.text === "c2")!
    await until(() => first.signal.aborted)
    await it.flush()
    expect(it.live()).toEqual([
      ["c0", "now"],
      ["c1", "next"],
    ])

    await until(() => it.renders.filter((r) => r.text === "c2").length === 2)
    it.render("c2")
    await it.flush()
    expect(it.live()).toEqual([
      ["c0", "now"],
      ["c1", "next"],
      ["c3", "background"],
    ])
    expect(it.renders.filter((r) => r.text === "c2").map((r) => r.priority)).toEqual(["background", "background"])
    expect(it.errors).toEqual([])
    expect(it.speech.speaking()).toBe(true)
    it.dispose()
  })

  test("a background render refused three times is left for the cursor to reach, where it fails loudly", async () => {
    const it = setup(undefined, 30)
    it.speech.show(key(), "A")
    it.send(...chunks("c0", "c1", "c2", "c3", "c4", "c5"))
    await it.flush()
    const reason = "speech engine answered 500: out of memory"
    const asked = (n: number) => until(() => it.renders.filter((r) => r.text === "c2").length === n)
    it.refuse("c2", 502, reason)
    await it.flush()
    expect(it.live()).toEqual([
      ["c0", "now"],
      ["c1", "next"],
    ])
    await asked(2)
    await it.flush()
    expect(it.live()).toEqual([
      ["c0", "now"],
      ["c1", "next"],
      ["c2", "background"],
    ])
    it.refuse("c2", 502, reason)
    await asked(3)
    it.refuse("c2", 502, reason)
    await until(() => it.renders.some((r) => r.text === "c3"))
    await it.flush()
    expect(it.live()).toEqual([
      ["c0", "now"],
      ["c1", "next"],
      ["c3", "background"],
    ])
    expect(it.renders.filter((r) => r.text === "c2").map((r) => r.priority)).toEqual([
      "background",
      "background",
      "background",
    ])
    expect(it.errors).toEqual([])
    expect(it.speech.speaking()).toBe(true)

    it.render("c0")
    it.render("c1")
    await it.flush()
    it.speech.seek(2)
    await asked(4)
    await it.flush()
    expect(it.renders.findLast((r) => r.text === "c2")!.priority).toBe("now")
    it.refuse("c2", 502, reason)
    await it.flush()
    expect(it.errors).toEqual([`Speech for part 3 of 6 failed: 502 ${reason}`])
    it.dispose()
  })

  test("showing a reading again gives its given-up background chunks another try", async () => {
    const it = setup(undefined, 10)
    const a = key()
    it.speech.show(a, "A")
    it.send(...chunks("c0", "c1", "c2", "c3"))
    await it.flush()
    const reason = "speech engine answered 500: out of memory"
    for (const n of [1, 2, 3]) {
      await until(() => it.renders.filter((r) => r.text === "c2").length === n)
      it.refuse("c2", 502, reason)
    }
    await until(() => it.renders.some((r) => r.text === "c3"))
    it.render("c0")
    it.render("c1")
    it.render("c3")
    await it.flush()
    expect(it.live()).toEqual([])

    it.speech.show(key(), "B")
    it.speech.show(a, "A")
    expect(it.live()).toEqual([["c2", "background"]])
    expect(it.errors).toEqual([])
    it.dispose()
  })

  test("a voice change gives given-up background chunks another try", async () => {
    const it = setup(undefined, 10)
    it.speech.show(key(), "A")
    it.send(...chunks("c0", "c1", "c2"))
    await it.flush()
    for (const n of [1, 2, 3]) {
      await until(() => it.renders.filter((r) => r.text === "c2").length === n)
      it.refuse("c2", 502, "out of memory")
    }
    await it.flush()
    await new Promise((resolve) => setTimeout(resolve, 30))
    await it.flush()
    expect(it.live()).toEqual([
      ["c0", "now"],
      ["c1", "next"],
    ])

    it.speech.revoice()
    expect(it.live()).toEqual([
      ["c0", "now"],
      ["c1", "next"],
      ["c2", "background"],
    ])
    expect(it.errors).toEqual([])
    it.dispose()
  })

  test("no retry is sent once its reading has been replaced or closed", async () => {
    const it = setup(undefined, 20)
    it.speech.show(key(), "A")
    it.send(...chunks("a0", "a1", "a2"))
    await it.flush()
    it.refuse("a2", 502, "out of memory")
    await it.flush()
    it.speech.show(key(), "B")
    it.send(...chunks("b0", "b1", "b2", "b3"))
    await it.flush()
    it.refuse("b2", 502, "out of memory")
    it.speech.close()
    await new Promise((resolve) => setTimeout(resolve, 50))
    await it.flush()
    expect(it.renders.map((r) => r.text)).toEqual(["a0", "a1", "a2", "b0", "b1", "b2"])
    it.dispose()
  })

  test("a held reading whose text changed is replaced: its audio is revoked and its position forgotten", async () => {
    const it = setup()
    const a = key()
    it.speech.show(a, "A")
    it.send(...chunks("a0", "a1", "a2"))
    await it.flush()
    it.render("a0")
    it.render("a1")
    await it.flush()
    it.audio.finish()
    await it.flush()
    expect(it.speech.index()).toBe(1)
    const urls = [...it.voiced.keys()]
    expect(urls.length).toBe(2)

    it.speech.show(key(), "B")
    it.speech.show(a, "A edited")
    expect(urls.filter((url) => it.voiced.has(url))).toEqual([])
    expect(it.speech.index()).toBe(0)
    expect(it.speech.speaking()).toBe(true)
    expect(it.speech.armed()).toBe(false)
    expect(it.prepares.map((p) => p.body.text)).toEqual(["A", "B", "A edited"])
    it.dispose()
  })

  test("a playback error names the chunk the element was playing", async () => {
    const it = setup()
    it.speech.show(key(), "A")
    it.send(...chunks("a0", "a1", "a2"))
    await it.flush()
    it.render("a0")
    it.render("a1")
    await it.flush()
    it.audio.finish()
    expect(await it.holding()).toBe("a1")
    it.audio.onerror!()
    expect(it.errors).toEqual(["Playback failed: chunk 2"])
    expect(it.speech.speaking()).toBe(false)
    expect(it.speech.armed()).toBe(true)
    it.dispose()
  })

  test("showing a halted reading again lets it fetch again, even when it opens armed", async () => {
    const it = setup()
    const a = key()
    it.speech.show(a, "A")
    it.send(...chunks("a0", "a1", "a2"))
    await it.flush()
    it.render("a0")
    await it.flush()
    it.audio.finish()
    await it.flush()
    it.refuse("a1", 503, "speech engine unreachable")
    await it.flush()
    expect(it.errors).toEqual(["Speech for part 2 of 3 failed: 503 speech engine unreachable"])
    expect(it.live()).toEqual([])

    it.speech.show(key(), "B")
    it.speech.show(a, "A")
    expect(it.speech.armed()).toBe(true)
    expect(it.speech.index()).toBe(1)
    expect(it.live()).toEqual([
      ["a1", "now"],
      ["a2", "next"],
    ])
    it.dispose()
  })

  test("a failed background chunk waits out its backoff even when other chunks arrive", async () => {
    const it = setup(undefined, 40)
    it.speech.show(key(), "A")
    it.send(
      { type: "chunk", index: 0, text: "c0" },
      { type: "chunk", index: 1, text: "c1" },
      { type: "chunk", index: 2, text: "c2" },
      { type: "chunk", index: 3, text: "c3" },
    )
    await it.flush()
    expect(it.live()).toEqual([
      ["c0", "now"],
      ["c1", "next"],
      ["c2", "background"],
    ])

    it.refuse("c2", 503, "speech engine answered 500: busy")
    await it.flush()
    it.send({ type: "chunk", index: 4, text: "c4" })
    await it.flush()
    expect(it.renders.filter((r) => r.text === "c2").length).toBe(1)
    expect(it.live()).toEqual([
      ["c0", "now"],
      ["c1", "next"],
      ["c3", "background"],
    ])

    await until(() => it.renders.filter((r) => r.text === "c2").length === 2)
    expect(it.renders.filter((r) => r.text === "c2").map((r) => r.priority)).toEqual(["background", "background"])
    expect(it.errors).toEqual([])
    it.dispose()
  })

  test("a skip while speaking stops the audio but keeps the HUD open, armed at the new chunk", async () => {
    const it = setup()
    it.speech.show(key(), "A")
    it.send(...chunks("a0", "a1", "a2"))
    await it.flush()
    it.render("a0")
    await it.flush()
    expect(it.speech.speaking()).toBe(true)
    it.speech.next()
    expect(it.speech.speaking()).toBe(false)
    expect(it.speech.armed()).toBe(true)
    expect(it.speech.open()).toBe(true)
    expect(it.speech.index()).toBe(1)
    it.dispose()
  })

  test("a failed render for a chunk the listener has skipped past is retried later, never stopping the reading", async () => {
    const it = setup(undefined, 1_000_000, 60_000)
    it.speech.show(key(), "A")
    it.send(...chunks("c0", "c1", "c2", "c3", "c4", "c5"))
    await it.flush()
    it.speech.seek(3)
    it.speech.seek(4)
    it.refuse("c0", 503, "speech engine answered 500: busy")
    await it.flush()
    expect(it.errors).toEqual([])

    it.speech.start()
    await it.flush()
    expect(it.live().filter(([, priority]) => priority !== "background")).toEqual([
      ["c4", "now"],
      ["c5", "next"],
    ])
    expect(it.errors).toEqual([])
    it.dispose()
  })

  test("audio that lands while paused reads as ready, not preparing", async () => {
    const it = setup()
    it.speech.show(key(), "A")
    it.send(...chunks("a0", "a1"))
    await it.flush()
    it.render("a0")
    await it.flush()
    it.audio.finish()
    it.speech.pause()
    expect(it.speech.loading()).toBe(true)
    it.render("a1")
    await it.flush()
    expect(it.speech.loading()).toBe(false)
    expect(it.speech.paused()).toBe(true)
    it.dispose()
  })

  test("waiting past the last chunk known so far never counts beyond the total", async () => {
    const it = setup()
    it.speech.show(key(), "A")
    it.send({ type: "chunk", index: 0, text: "a0" })
    await it.flush()
    it.render("a0")
    await it.flush()
    it.audio.finish()
    expect(it.speech.index()).toBe(1)
    expect(it.speech.total()).toBe(2)
    it.dispose()
  })

  test("a replaced reading's late done neither closes nor moves the reading that replaced it", async () => {
    const it = setup()
    it.speech.show(key(), "A")
    it.send({ type: "chunk", index: 0, text: "a0" })
    await it.flush()
    it.speech.show(key(), "B")
    it.prepares[1]!.send(...chunks("b0", "b1", "b2"))
    await it.flush()
    it.render("b0")
    await it.flush()
    it.audio.finish()
    expect(it.speech.index()).toBe(1)

    it.prepares[0]!.send({ type: "done", total: 1 })
    await it.flush()
    expect(it.speech.open()).toBe(true)
    expect(it.speech.speaking()).toBe(true)
    expect(it.speech.index()).toBe(1)
    it.dispose()
  })

  test("a remembered place past the end of a shorter rewrite plays its last chunk rather than closing", async () => {
    const it = setup()
    const a = key()
    it.speech.show(a, "A")
    it.send(...chunks("a0", "a1", "a2", "a3", "a4", "a5").slice(0, -1))
    await it.flush()
    it.speech.seek(5)
    it.speech.show(key(), "B")
    it.speech.show(a, "A")
    expect(it.speech.armed()).toBe(true)
    expect(it.speech.index()).toBe(0)
    it.speech.start()
    it.send(...chunks("n0", "n1", "n2", "n3"))
    await it.flush()
    expect(it.speech.open()).toBe(true)
    expect(it.speech.index()).toBe(3)
    expect(it.live().filter(([, priority]) => priority === "now")).toEqual([["n3", "now"]])
    it.dispose()
  })

  test("a lock-screen skip keeps playing, and a skip that goes nowhere changes nothing", async () => {
    const handlers = new Map<string, (() => void) | null>()
    Object.defineProperty(navigator, "mediaSession", {
      configurable: true,
      value: { metadata: null, setActionHandler: (name: string, run: (() => void) | null) => handlers.set(name, run) },
    })
    const it = setup()
    it.speech.show(key(), "A")
    it.send(...chunks("a0", "a1"))
    await it.flush()
    it.render("a0")
    it.render("a1")
    await it.flush()
    const played = it.audio.played.length
    handlers.get("previoustrack")!()
    expect(it.audio.played.length).toBe(played)
    handlers.get("nexttrack")!()
    expect(it.speech.speaking()).toBe(true)
    expect(it.speech.index()).toBe(1)
    expect(await it.holding()).toBe("a1")
    it.dispose()
    delete (navigator as { mediaSession?: unknown }).mediaSession
  })

  test("next while waiting past the last chunk known stays put, from the HUD and from the lock screen", async () => {
    const handlers = new Map<string, (() => void) | null>()
    Object.defineProperty(navigator, "mediaSession", {
      configurable: true,
      value: { metadata: null, setActionHandler: (name: string, run: (() => void) | null) => handlers.set(name, run) },
    })
    const it = setup()
    it.speech.show(key(), "A")
    it.send({ type: "chunk", index: 0, text: "a0" })
    await it.flush()
    it.render("a0")
    await it.flush()
    it.audio.finish()
    expect(it.speech.index()).toBe(1)
    const played = it.audio.played.length

    it.speech.next()
    handlers.get("nexttrack")!()
    expect(it.speech.index()).toBe(1)
    expect(it.speech.speaking()).toBe(true)
    expect(it.audio.played.length).toBe(played)
    it.dispose()
    delete (navigator as { mediaSession?: unknown }).mediaSession
  })

  test("a lock-screen skip on a paused reading moves it without starting playback", async () => {
    const handlers = new Map<string, (() => void) | null>()
    Object.defineProperty(navigator, "mediaSession", {
      configurable: true,
      value: { metadata: null, setActionHandler: (name: string, run: (() => void) | null) => handlers.set(name, run) },
    })
    const it = setup()
    it.speech.show(key(), "A")
    it.send(...chunks("a0", "a1"))
    await it.flush()
    it.render("a0")
    it.render("a1")
    await it.flush()
    it.speech.pause()
    handlers.get("nexttrack")!()
    expect(it.speech.index()).toBe(1)
    expect(it.speech.speaking()).toBe(false)
    expect(it.speech.armed()).toBe(true)
    it.dispose()
    delete (navigator as { mediaSession?: unknown }).mediaSession
  })

  test("audio of a reading pushed out of the voiced few is revoked", async () => {
    const it = setup()
    const urls: string[] = []
    for (const text of ["A", "B", "C", "D"]) {
      it.speech.show(key(), text)
      it.send(...chunks(`${text}0`))
      await it.flush()
      it.render(`${text}0`)
      await it.flush()
      urls.push(it.audio.src)
    }
    expect(urls.map((url) => it.voiced.has(url))).toEqual([false, true, true, true])
    it.dispose()
  })

  test("a voice change revokes the audio it drops, and the playing chunk's once the element moves off it", async () => {
    const it = setup()
    it.speech.show(key(), "A")
    it.send(...chunks("a0", "a1", "a2"))
    await it.flush()
    it.render("a0")
    it.render("a1")
    it.render("a2")
    await it.flush()
    const playing = it.audio.src
    const others = [...it.voiced.keys()].filter((url) => url !== playing)
    expect(others.length).toBe(2)

    it.speech.revoice()
    expect(others.filter((url) => it.voiced.has(url))).toEqual([])
    expect(it.voiced.has(playing)).toBe(true)

    it.render("a1")
    await it.flush()
    it.audio.finish()
    expect(await it.holding()).toBe("a1")
    expect(it.voiced.has(playing)).toBe(false)
    it.dispose()
  })
})
