import { createStore } from "solid-js/store"
import { onCleanup } from "solid-js"
import { directoryHeader } from "@opencode-ai/sdk/v2/client"
import { HEADERS_MS } from "./fetch"

// Below 0.5 the voice slurs and above 2.5 it stops being followable, so the
// range ends there rather than wherever repeated presses would reach.
export const RATE = { min: 0.5, max: 2.5, step: 0.25, base: 1 } as const

// The English speakers of the sidecar's kokoro-v1 model, for the read-aloud
// picker. The names are the sidecar's contract (it maps each to a speaker id);
// the labels are only what the dropdown shows. This list is fixed by the loaded
// model, so it is stated here rather than fetched. It must stay in step with
// the sidecar's speaker list.
export const VOICES: { id: string; label: string }[] = [
  { id: "af_bella", label: "Bella (US female)" },
  { id: "af_heart", label: "Heart (US female)" },
  { id: "af_nova", label: "Nova (US female)" },
  { id: "af_sarah", label: "Sarah (US female)" },
  { id: "af_nicole", label: "Nicole (US female)" },
  { id: "af_sky", label: "Sky (US female)" },
  { id: "af_alloy", label: "Alloy (US female)" },
  { id: "af_aoede", label: "Aoede (US female)" },
  { id: "af_jessica", label: "Jessica (US female)" },
  { id: "af_kore", label: "Kore (US female)" },
  { id: "af_river", label: "River (US female)" },
  { id: "am_adam", label: "Adam (US male)" },
  { id: "am_michael", label: "Michael (US male)" },
  { id: "am_echo", label: "Echo (US male)" },
  { id: "am_eric", label: "Eric (US male)" },
  { id: "am_fenrir", label: "Fenrir (US male)" },
  { id: "am_liam", label: "Liam (US male)" },
  { id: "am_onyx", label: "Onyx (US male)" },
  { id: "am_puck", label: "Puck (US male)" },
  { id: "am_santa", label: "Santa (US male)" },
  { id: "bf_alice", label: "Alice (UK female)" },
  { id: "bf_emma", label: "Emma (UK female)" },
  { id: "bf_isabella", label: "Isabella (UK female)" },
  { id: "bf_lily", label: "Lily (UK female)" },
  { id: "bm_daniel", label: "Daniel (UK male)" },
  { id: "bm_fable", label: "Fable (UK male)" },
  { id: "bm_george", label: "George (UK male)" },
  { id: "bm_lewis", label: "Lewis (UK male)" },
]

const RATE_KEY = "opencode-speech-rate"

const clampRate = (rate: number) =>
  Math.round(Math.min(RATE.max, Math.max(RATE.min, rate)) / RATE.step) * RATE.step

// Private browsing and blocked storage both throw on access rather than
// returning null, so every read goes through here.
function safeStorage() {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

// A listening speed belongs to the person rather than to one reading, so it
// outlives both the reading and the page.
export function storedRate(store: Pick<Storage, "getItem"> | undefined = safeStorage()) {
  const held = Number(store?.getItem(RATE_KEY))
  return held >= RATE.min && held <= RATE.max ? clampRate(held) : RATE.base
}

// The sidecar queues renders by this, strictly one at a time: the chunk under
// the cursor jumps everything, the one after it is next, and the rest of the
// reading fills in behind them one request at a time.
export type Priority = "now" | "next" | "background"

// One silent 16-bit mono PCM sample at 8 kHz, inline so that unlocking costs no
// request. Setting it as src inside the gesture lifts the element's gesture
// restriction in WebKit (HTMLMediaElement prepareForLoad calls
// removeBehaviorRestrictionsAfterFirstUserGesture; WebKit c37c8fb33b).
const SILENCE = "data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQIAAAAAAA=="

// Identifies this tab to the sidecar. Each showing of a reading extends it with
// a counter, so /tts/done, which releases this id's queued renders, can only
// ever reach the reading that sent it, never the one that replaced it.
const LISTENER = Math.random().toString(36).slice(2)
let showings = 0

// A render the sidecar never answers would otherwise hold its chunk in flight
// forever, since the scheduler re-requests an index in flight only when its
// priority changes. The clock starts at send, so time queued behind other
// renders counts. Fetch defines no request timeout (fetch.spec.whatwg.org). A
// render unanswered this long means the sidecar is stuck: a warm 289 to 341
// character chunk renders in 861 to 1087 ms (sidecar log). The ceiling is the
// app fetch guard's headers deadline for either priority, since /tts/speak
// sends its headers only once the render is done, so no longer one could apply.
const TIMEOUT_MS = { foreground: HEADERS_MS, background: HEADERS_MS }

// A choice: silent re-requests a failed background render gets before it is
// left for the cursor to reach, where it is requested at now or next and fails
// loudly. Two cover a passing refusal without re-asking a sidecar that keeps
// failing.
const RETRIES = 2

// A choice (not measured): spaces those retries so a refusing sidecar is not
// asked again at once.
const BACKOFF_MS = 2_000

// Where the listener stopped in each text part, keyed by part id. Module-level
// so it survives the directory layout remounting; in memory only, since a place
// in a reading is worth nothing after a reload.
const positions = new Map<string, number>()
// A choice: bounds the map, which would otherwise hold every part read for the
// life of the tab; far more parts than a person returns to in one sitting, at
// one number each.
const REMEMBERED = 50

// A choice: rewritten chunk lists are small text, kept for this many parts so
// returning to one skips the rewrite. Audio is held for far fewer, since it is
// the heavy part.
const PREPARED = 20
const VOICED = 3

// A choice (not measured): long enough that a quick run of skip presses
// settles before any request moves.
const SETTLE_MS = 300

function remember(key: string, at: number) {
  positions.delete(key)
  positions.set(key, at)
  for (const old of positions.keys()) {
    if (positions.size <= REMEMBERED) break
    positions.delete(old)
  }
}

type Reading = {
  key: string
  // The x-speech-session this showing sends, fresh each time it is shown.
  id: string
  text: string
  chunks: string[]
  done: boolean
  blobs: Map<number, string>
  // Each request remembers the priority it was sent at, so a skip can move it
  // to the rank the new cursor gives it, up or down.
  flight: Map<number, { controller: AbortController; priority: Priority }>
  prepare?: AbortController
  // Set by a failed render, so the scheduler stops re-requesting a chunk the
  // sidecar keeps refusing until the listener asks again.
  halted: boolean
  // Failed background renders per chunk, which bounds their silent retries.
  failures: Map<number, number>
  // Failed background chunks waiting out their backoff, each with the timer that
  // ends its wait and schedules again. The timer owns the wait rather than a
  // Date.now() deadline: under the test runtime a timer fired a millisecond
  // before Date.now() reached its deadline, and a pass that skips the chunk
  // then leaves nothing to re-arm.
  waits: Map<number, ReturnType<typeof setTimeout>>
}

// A new src or a pause rejects a pending play() with an "AbortError" DOMException:
// html.spec.whatwg.org/multipage/media.html#reject-pending-play-promises
const aborted = (error: unknown) => error instanceof Error && error.name === "AbortError"

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function createSpeech(opts?: {
  url?: () => string
  session?: () => string
  directory?: () => string
  title?: () => string
  fetch?: typeof fetch
  audio?: () => HTMLAudioElement
  // Object URL minting for rendered audio; a test swaps it to see what the
  // element holds without patching the global.
  objects?: { create: (blob: Blob) => string; revoke: (url: string) => void }
  // How long skip presses must pause before requests move.
  debounce?: number
  // How long a render may go unanswered, by whether it is for the cursor or the
  // one after it (foreground) or filling in behind them (background).
  timeout?: { foreground: number; background: number }
  // How long after a failed background render the scheduler looks again.
  backoff?: number
  onError?: (message: string) => void
}) {
  const timeouts = opts?.timeout ?? TIMEOUT_MS
  const backoff = opts?.backoff ?? BACKOFF_MS
  const objects = opts?.objects ?? {
    create: (blob: Blob) => URL.createObjectURL(blob),
    revoke: (url: string) => URL.revokeObjectURL(url),
  }
  const [store, setStore] = createStore({
    speaking: false,
    paused: false,
    loading: false,
    rate: storedRate(),
    index: 0,
    total: 0,
    // The words at the cursor, so the HUD shows what is being read rather than
    // only how far along it is.
    chunk: "",
    // Open with nothing playing, which is what lets the HUD offer
    // resume-or-restart before anything plays.
    armed: false,
    // Reactive because a message box reads it during render to tell whether the
    // reading on screen is its own.
    key: "",
  })

  const supported = () => typeof window !== "undefined" && (!!opts?.audio || typeof Audio !== "undefined")
  const request = opts?.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  const base = () => opts?.url?.() ?? ""

  const readings = new Map<string, Reading>()
  let current: Reading | undefined
  let cursor = 0
  // The chunk whose audio the element holds, undefined while it holds nothing
  // or only the unlock sample, so that sample's end is never taken for a chunk's.
  let loaded: number | undefined
  let settle: ReturnType<typeof setTimeout> | undefined
  const unsettle = () => {
    clearTimeout(settle)
    settle = undefined
  }
  const unwait = (r: Reading) => {
    for (const timer of r.waits.values()) clearTimeout(timer)
    r.waits.clear()
  }
  // ONE element for every reading, reused by swapping src. iOS grants playback
  // to the element a user gesture touched, and only that one.
  // WebKit keeps these restrictions per element: github.com/WebKit/WebKit/blob/c37c8fb33b880e5d66f25e80ba0a1d22006fd044/Source/WebCore/html/MediaElementSession.cpp
  let player: HTMLAudioElement | undefined
  // Audio dropped by a voice change while the element was still playing it, so
  // it can only be revoked once the element has moved off it.
  let orphans: string[] = []

  const release = () => {
    for (const url of orphans) objects.revoke(url)
    orphans = []
  }

  const sync = () => {
    const r = current
    setStore({
      key: r?.key ?? "",
      // A remembered place shows once the reading has a first chunk.
      index: r?.chunks.length ? cursor : 0,
      // At least the cursor's chunk, since playback can wait past the last one
      // known so far.
      total: r?.chunks.length ? Math.max(r.chunks.length, cursor + 1) : 0,
      chunk: r?.chunks[cursor] ?? "",
      // Audio that landed while paused is held for resume, so it is ready.
      loading: !!r && (store.speaking ? loaded !== cursor && !r.blobs.has(cursor) : !r.chunks[cursor]),
    })
  }

  const fail = (what: string, error: unknown) => {
    opts?.onError?.(`${what}: ${describe(error)}`)
  }

  // Setting src runs the load algorithm, which resets playbackRate to
  // defaultPlaybackRate (html.spec.whatwg.org/multipage/media.html#media-element-load-algorithm),
  // so defaultPlaybackRate is set too and that reset lands on the chosen rate.
  // Re-applying at loadedmetadata as well is a choice: it costs nothing.
  const applyRate = () => {
    if (!player) return
    player.defaultPlaybackRate = store.rate
    player.playbackRate = store.rate
  }

  const media = () => (typeof navigator !== "undefined" ? navigator.mediaSession : undefined)

  const element = () => {
    if (player) return player
    const audio = opts?.audio?.() ?? new Audio()
    audio.preservesPitch = true
    audio.onloadedmetadata = applyRate
    audio.onended = () => advance()
    audio.onerror = () => {
      if (loaded === undefined || !current) return
      const at = loaded
      halt()
      fail("Playback failed", new Error(`chunk ${at + 1}`))
      setStore({ speaking: false, paused: false, armed: true })
      sync()
    }
    // An OS interruption (a call, another app's audio) can pause the element
    // without going through the HUD
    // (w3c.github.io/audio-session/#audio-session-element-suspend-steps).
    // The end of a chunk also fires pause, which is not the listener pausing
    // (html.spec.whatwg.org/multipage/media.html#reaches-the-end: pause fires
    // before ended).
    audio.onpause = () => {
      if (audio.ended || loaded === undefined || !store.speaking || store.paused) return
      setStore("paused", true)
    }
    audio.onplay = () => {
      if (loaded === undefined || !store.speaking || !store.paused) return
      setStore("paused", false)
    }
    player = audio
    return audio
  }

  // Playback permission comes from a user gesture, and the first chunk only
  // arrives after the rewrite streams in through reader.read() calls, which
  // WebKit does not carry the gesture across (bugs.webkit.org/show_bug.cgi?id=214722,
  // "Propagating media only user gesture through Fetch ReadableStream"). So the
  // element is started on a silent source while the click is still on the
  // stack; every chunk after that only swaps src.
  const unlock = () => {
    const audio = element()
    loaded = undefined
    audio.src = SILENCE
    applyRate()
    audio.play().catch(() => {})
  }

  const halt = () => {
    loaded = undefined
    if (!player) return
    player.pause()
    player.removeAttribute("src")
    player.load()
    release()
  }

  // w3c.github.io/audio-session/#enumdef-audiosessiontype
  const session = (type: "playback" | "auto") => {
    const audio = (navigator as { audioSession?: { type: string } }).audioSession
    if (audio) audio.type = type
  }

  const swap = (at: number) => {
    const url = current?.blobs.get(at)
    if (!url) return false
    const audio = element()
    loaded = at
    applyRate()
    audio.src = url
    applyRate()
    release()
    audio.play().catch((error) => {
      if (aborted(error) || loaded !== at) return
      halt()
      fail("Playback failed", error)
      setStore({ speaking: false, paused: false, armed: true })
      sync()
    })
    sync()
    return true
  }

  // `readings` is oldest-first: `reading` moves each one it touches to the end.
  const retain = () => {
    const recent = [...readings.values()].reverse()
    for (const r of recent.slice(VOICED)) {
      for (const url of r.blobs.values()) objects.revoke(url)
      r.blobs.clear()
    }
    for (const r of recent.slice(PREPARED)) readings.delete(r.key)
  }

  const plan = (r: Reading) => {
    const wanted = new Map<number, Priority>()
    // The chunk the element is playing counts as held even once a voice change
    // has dropped its blob: it finishes in the old voice, and fetching it again
    // would only queue it ahead of the chunk that plays next.
    const missing = (at: number) => at < r.chunks.length && !r.blobs.has(at) && at !== loaded
    if (missing(cursor)) wanted.set(cursor, "now")
    if (missing(cursor + 1)) wanted.set(cursor + 1, "next")
    const order = [
      ...Array.from({ length: Math.max(0, r.chunks.length - cursor - 2) }, (_, i) => cursor + 2 + i),
      ...Array.from({ length: Math.min(cursor, r.chunks.length) }, (_, i) => i),
    ]
    const behind = order.find((at) => missing(at) && (r.failures.get(at) ?? 0) <= RETRIES && !r.waits.has(at))
    if (behind !== undefined) wanted.set(behind, "background")
    return wanted
  }

  // The sidecar ranks a job by the highest priority any live request for it
  // carries, so a request is moved by sending its replacement before dropping
  // it: the sidecar joins the new one to the queued job rather than starting
  // over, and the job's rank follows whichever request is still live.
  const move = (r: Reading, at: number, priority: Priority) => {
    const flight = r.flight.get(at)
    render(r, at, priority)
    flight?.controller.abort()
  }

  // While skip presses are settling, a landing blob or a retry timer must not
  // plan against a chunk the listener is only passing through.
  const schedule = () => {
    const r = current
    if (!r || r.halted || settle) return
    const wanted = plan(r)
    for (const [at, priority] of wanted) {
      if (r.flight.get(at)?.priority !== priority) move(r, at, priority)
    }
    // A render the plan no longer ranks is still audio the reading will need,
    // so it carries on, but behind everything the plan does rank. Only the
    // newest such render is kept: each seek strands the old window, and every
    // one kept is a render the sidecar works through before the rest.
    const unwanted = [...r.flight].filter(([at]) => !wanted.has(at))
    for (const [at, flight] of unwanted.slice(0, -1)) {
      r.flight.delete(at)
      flight.controller.abort()
    }
    const kept = unwanted.at(-1)
    if (kept && kept[1].priority !== "background") move(r, kept[0], "background")
  }

  const render = (r: Reading, at: number, priority: Priority) => {
    const controller = new AbortController()
    const background = priority === "background"
    const limit = background ? timeouts.background : timeouts.foreground
    let expired = false
    const timer = setTimeout(() => {
      expired = true
      controller.abort()
    }, limit)
    // Re-inserted rather than overwritten, so the map's order is the order the
    // live requests were sent, which is what the scheduler's cap keeps by (set
    // keeps an existing key's position: tc39.es/ecma262/#sec-map.prototype.set).
    r.flight.delete(at)
    r.flight.set(at, { controller, priority })
    // Moving, ending, or revoicing the reading replaces or clears this entry,
    // which is what tells an abort by them from one by the timer.
    const superseded = () => r.flight.get(at)?.controller !== controller
    request(`${base()}/tts/speak`, {
      method: "POST",
      body: JSON.stringify({ text: r.chunks[at], priority }),
      headers: { "content-type": "application/json", "x-speech-session": r.id },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`${response.status} ${await response.text().catch(() => "")}`.trim())
        return response.blob()
      })
      .then((blob) => {
        if (superseded()) return
        r.flight.delete(at)
        r.failures.delete(at)
        clearTimeout(r.waits.get(at))
        r.waits.delete(at)
        r.blobs.set(at, objects.create(blob))
        if (r !== current) return
        if (store.speaking && !store.paused && at === cursor && loaded !== cursor) swap(at)
        sync()
        schedule()
      })
      .catch((error) => {
        if (superseded()) return
        r.flight.delete(at)
        // Nobody is waiting on a background render yet, nor on a foreground one
        // that is no longer the cursor's chunk or the next, so either failure
        // is left for a later scheduling pass to retry rather than stopping the
        // reading.
        if (background || (r === current && at !== cursor && at !== cursor + 1)) {
          r.failures.set(at, (r.failures.get(at) ?? 0) + 1)
          if (r !== current) return
          clearTimeout(r.waits.get(at))
          r.waits.set(
            at,
            setTimeout(() => {
              r.waits.delete(at)
              if (r === current) schedule()
            }, backoff),
          )
          return
        }
        if (r !== current) return
        r.halted = true
        for (const other of r.flight.values()) other.controller.abort()
        r.flight.clear()
        fail(
          `Speech for part ${at + 1} of ${r.chunks.length} failed`,
          expired ? new Error(`no audio for part ${at + 1} after ${limit / 1000}s`) : error,
        )
        if (loaded !== cursor) setStore({ speaking: false, paused: false, armed: true })
        sync()
      })
      .finally(() => clearTimeout(timer))
  }

  const parse = (r: Reading, line: string) => {
    const message = (() => {
      try {
        return JSON.parse(line) as { type?: string; index?: number; text?: string; total?: number; message?: string }
      } catch {
        return undefined
      }
    })()
    if (!message) throw new Error(`unreadable line from the server: ${line.slice(0, 80)}`)
    if (message.type === "error") throw new Error(message.message ?? "the server reported an error")
    if (message.type === "done") {
      if (message.total !== r.chunks.length)
        throw new Error(`the server announced ${message.total} parts but sent ${r.chunks.length}`)
      if (!r.chunks.length) throw new Error("the rewrite produced nothing to read")
      r.done = true
      return
    }
    if (message.type !== "chunk" || typeof message.text !== "string")
      throw new Error(`unexpected line from the server: ${line.slice(0, 80)}`)
    if (message.index !== r.chunks.length)
      throw new Error(`part ${message.index} arrived where part ${r.chunks.length} was due`)
    r.chunks.push(message.text)
  }

  const prepare = async (r: Reading) => {
    const controller = new AbortController()
    r.prepare = controller
    const response = await request(`${base()}/tts/prepare`, {
      method: "POST",
      body: JSON.stringify({ text: r.text, sessionID: opts?.session?.() ?? "" }),
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": directoryHeader(opts?.directory?.() ?? ""),
        "x-speech-session": r.id,
      },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`${response.status} ${await response.text().catch(() => "")}`.trim())
    if (!response.body) throw new Error("the server sent no body")
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let held = ""
    const take = (lines: string[]) => {
      const before = r.chunks.length
      for (const line of lines.filter((line) => line.trim())) parse(r, line)
      if (r !== current) return
      // Playback can run past the last chunk known so far, waiting on the next;
      // if `done` then says there is none, the listener has heard it all. A
      // remembered place past the end of a shorter rewrite lands on its last
      // chunk instead.
      if (r.done && cursor >= r.chunks.length && store.speaking && loaded === cursor - 1) {
        cursor = 0
        return close()
      }
      if (r.done) cursor = Math.min(cursor, r.chunks.length - 1)
      if (r.chunks.length !== before || r.done) {
        sync()
        schedule()
      }
    }
    while (!r.done) {
      const read = await reader.read()
      if (read.done) break
      const lines = (held + decoder.decode(read.value, { stream: true })).split("\n")
      held = lines.pop() ?? ""
      take(lines)
    }
    if (!r.done) take([held + decoder.decode()])
    if (!r.done) throw new Error("the stream ended before the server finished")
    r.prepare = undefined
    reader.cancel().catch(() => {})
  }

  const reading = (key: string, text: string) => {
    const held = readings.get(key)
    // Deleted and set again below, so this reading moves to the newest end (set
    // keeps an existing key's position: tc39.es/ecma262/#sec-map.prototype.set).
    readings.delete(key)
    if (held && held.text !== text) {
      for (const url of held.blobs.values()) objects.revoke(url)
      for (const flight of held.flight.values()) flight.controller.abort()
      held.flight.clear()
      held.prepare?.abort()
      positions.delete(key)
    }
    const r: Reading =
      held && held.text === text
        ? held
        : {
            key,
            id: "",
            text,
            chunks: [],
            done: false,
            blobs: new Map(),
            flight: new Map(),
            halted: false,
            failures: new Map(),
            waits: new Map(),
          }
    // A new showing is the listener asking again, so whatever stopped the last
    // one gets another try.
    r.id = `${LISTENER}:${++showings}`
    r.halted = false
    r.failures.clear()
    unwait(r)
    readings.set(key, r)
    retain()
    return r
  }

  const setMedia = () => {
    const session = media()
    if (!session) return
    if (typeof MediaMetadata !== "undefined")
      session.metadata = new MediaMetadata({ title: opts?.title?.() ?? "", artist: "OpenCode" })
    session.setActionHandler("play", () => (store.speaking ? resume() : start()))
    session.setActionHandler("pause", () => pause())
    // A skip from the lock screen or a headset keeps playing: unlike one made
    // in the HUD, nobody is looking at the screen to choose what comes next. A
    // paused reading moves without playing, ready at the chunk it lands on.
    const skip = (move: () => void) => () => {
      const at = cursor
      const playing = store.speaking && !store.paused
      move()
      if (playing && cursor !== at) begin()
    }
    session.setActionHandler("nexttrack", skip(() => next()))
    session.setActionHandler("previoustrack", skip(() => previous()))
  }

  const clearMedia = () => {
    const session = media()
    if (!session) return
    session.metadata = null
    for (const action of ["play", "pause", "nexttrack", "previoustrack"] as const)
      session.setActionHandler(action, null)
  }

  // Ends the current reading entirely: every request it has in flight is
  // aborted and the sidecar is told to drop anything still queued for it.
  const end = () => {
    const r = current
    if (!r) return
    if (active === end) active = undefined
    current = undefined
    unsettle()
    unwait(r)
    remember(r.key, cursor)
    r.prepare?.abort()
    for (const flight of r.flight.values()) flight.controller.abort()
    r.flight.clear()
    if (!r.done) {
      for (const url of r.blobs.values()) objects.revoke(url)
      readings.delete(r.key)
    }
    halt()
    session("auto")
    clearMedia()
    request(`${base()}/tts/done`, { method: "POST", headers: { "x-speech-session": r.id } }).catch(() => {})
  }

  const close = () => {
    if (!current && !store.armed && !store.speaking) return
    end()
    setStore({ speaking: false, paused: false, loading: false, armed: false, chunk: "", key: "", total: 0, index: 0 })
  }

  const advance = () => {
    const r = current
    if (!r || loaded === undefined || loaded !== cursor) return
    if (r.done && cursor + 1 >= r.chunks.length) {
      cursor = 0
      return close()
    }
    cursor++
    remember(r.key, cursor)
    const playing = !store.paused && swap(cursor)
    if (!playing && r.halted) setStore({ speaking: false, paused: false, armed: true })
    sync()
    schedule()
  }

  // Playing mode: the HUD shows the reading as live, and whatever lands for the
  // cursor starts at once.
  const begin = () => {
    const r = current
    if (!r) return
    r.halted = false
    setStore({ armed: false, speaking: true, paused: false })
    session("playback")
    setMedia()
    unlock()
    swap(cursor)
    sync()
    unsettle()
    schedule()
  }

  // The speaker button on a text part calls this. A part never heard, or heard
  // to the end, has one obvious action, so it plays; one left partway has two,
  // so the HUD opens on that chunk and waits rather than guessing.
  const show = (key: string, text: string) => {
    if (!supported()) return
    active?.()
    end()
    const r = reading(key, text)
    current = r
    active = end
    const held = positions.get(key) ?? 0
    cursor = r.done ? Math.min(held, Math.max(r.chunks.length - 1, 0)) : held
    if (!r.done && !r.prepare)
      prepare(r).catch((error) => {
        if (r.prepare?.signal.aborted) return
        r.prepare?.abort()
        r.prepare = undefined
        readings.delete(r.key)
        if (r !== current) return
        fail("Preparing the speech failed", error)
        close()
      })
    if (held > 0) {
      setStore({ armed: true, speaking: false, paused: false })
      sync()
      return schedule()
    }
    begin()
  }

  const start = () => {
    if (!supported() || !current) return
    begin()
  }

  const pause = () => {
    if (!store.speaking || store.paused) return
    setStore("paused", true)
    player?.pause()
  }

  const resume = () => {
    if (!store.speaking || !store.paused) return
    setStore("paused", false)
    if (loaded === cursor) {
      player?.play().catch((error) => {
        if (aborted(error)) return
        fail("Playback failed", error)
        if (store.speaking) setStore("paused", true)
      })
      return
    }
    swap(cursor)
    sync()
  }

  const setRate = (rate: number) => {
    setStore("rate", clampRate(rate))
    applyRate()
    try {
      window.localStorage.setItem(RATE_KEY, String(store.rate))
    } catch {}
  }

  const faster = () => setRate(store.rate + RATE.step)
  const slower = () => setRate(store.rate - RATE.step)

  // Moving to another chunk stops the audio: the listener navigated to look,
  // and speaking over that would carry them past what they were reaching for.
  // The HUD moves at once; requests move only once the presses settle.
  const seek = (to: number) => {
    const r = current
    if (!r || !r.chunks.length) return
    // Waiting past the last chunk known so far, `next` stays put: clamping to
    // that chunk would move backwards and replay it. `previous` may step back
    // onto a chunk not yet known, and the cursor waits there for it.
    const target = Math.max(0, Math.min(to, Math.max(r.chunks.length - 1, cursor)))
    if (target === cursor) return
    if (store.speaking) {
      halt()
      setStore({ speaking: false, paused: false })
    }
    cursor = target
    remember(r.key, cursor)
    setStore("armed", true)
    sync()
    unsettle()
    settle = setTimeout(() => {
      settle = undefined
      schedule()
    }, opts?.debounce ?? SETTLE_MS)
  }

  const next = () => seek(cursor + 1)
  const previous = () => seek(cursor - 1)
  const restart = () => seek(0)

  // The voice changed server-side, so every rendered chunk is in the old one.
  // The chunk playing now finishes in the voice it started in.
  const revoice = () => {
    for (const r of readings.values()) {
      for (const [at, url] of r.blobs) {
        if (r === current && at === loaded) orphans.push(url)
        else objects.revoke(url)
        r.blobs.delete(at)
      }
      if (r !== current) continue
      for (const flight of r.flight.values()) flight.controller.abort()
      r.flight.clear()
      r.failures.clear()
      unwait(r)
    }
    schedule()
  }

  onCleanup(() => {
    close()
    for (const r of readings.values()) for (const url of r.blobs.values()) objects.revoke(url)
    readings.clear()
  })

  return {
    supported,
    speaking: () => store.speaking,
    paused: () => store.paused,
    loading: () => store.loading,
    armed: () => store.armed,
    open: () => store.armed || store.speaking,
    reading: (key: string) => (store.armed || store.speaking) && key === store.key,
    rate: () => store.rate,
    index: () => store.index,
    total: () => store.total,
    chunk: () => store.chunk,
    resuming: () => store.index > 0,
    show,
    start,
    close,
    pause,
    resume,
    seek,
    next,
    previous,
    restart,
    faster,
    slower,
    revoice,
  }
}

// One reading at a time across the whole app: a second speak button ends the
// reading in progress rather than two voices overlapping.
let active: (() => void) | undefined
