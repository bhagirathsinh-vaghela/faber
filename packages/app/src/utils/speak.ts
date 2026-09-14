import { createStore } from "solid-js/store"
import { onCleanup } from "solid-js"
import { convertMarkdown } from "speakable-text"

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

const SYMBOLS: [RegExp, string][] = [
  [/[→⟶]/g, " to "],
  [/[←⟵]/g, " from "],
  [/[↔⟷]/g, " both ways "],
  [/[⇒⟹]/g, " gives "],
  [/[✓✅☑]/g, " yes "],
  [/[✗❌✕✘]/g, " no "],
  [/⚠️?/g, " warning "],
  [/[•·]/g, " "],
  [/…/g, " "],
  [/(\d)\s*[–—]\s*(\d)/g, "$1 to $2"],
  [/[–—]/g, ", "],
  [/≈/g, " about "],
  [/≥/g, " at least "],
  [/≤/g, " at most "],
]

function speakable(markdown: string) {
  // A bare URL is otherwise spelled out character by character, which is
  // unlistenable and carries nothing the surrounding words do not.
  const spoken = convertMarkdown(markdown.replace(/(?<![(<\]])https?:\/\/\S+/g, "a link")).text
  return SYMBOLS.reduce((text, [pattern, word]) => text.replace(pattern, word), spoken)
    .replace(/[ \t]+/g, " ")
    .replace(/ ([,.])/g, "$1")
    .trim()
}

// A table and a code block are the two things a listener skips rather than
// hears, so each is forced into a chunk of its own. Packing them in with the
// prose around them would make one press skip the sentences either side.
// The library brackets both with an opening and closing phrase, which is what
// makes the boundaries findable.
const REGIONS = /(Table\.\s.*?End table\.|Code block\.\s.*?End code block\.)/gs

// A single capture group makes split alternate prose, region, prose, so the odd
// positions are the regions themselves. Carrying that as a flag is what lets the
// pacing below leave them whole.
function regions(text: string) {
  return text
    .split(REGIONS)
    .map((value, at) => ({ value: value.trim(), atomic: at % 2 === 1 }))
    .filter((part) => part.value)
}

// A chunk boundary is heard as a pause, so chunks end at sentence ends where a
// pause belongs. The cap only bounds a runaway paragraph: it is set well above
// a normal sentence so that reaching it — and cutting mid-sentence, which is
// heard as the speech stopping short — takes prose that never ends a sentence.
const CHUNK = 600

// Chunk sizes for the rewrite path, in characters, following the streaming-TTS
// field (ElevenLabs' [120,160,250,290] escalating schedule, Deepgram's 50-100
// voice / 200-400 long-form, LiveKit's min/max buffer). Read-aloud of prose is
// long-form, so these sit at the larger end. Only the FIRST chunk gates when
// audio starts (the next is prefetched while it plays), so it alone is kept
// small for a fast start; the rest group larger for better prosody and fewer
// round-trips.
const FIRST_CHUNK = 90
const MIN_CHUNK = 180
const MAX_CHUNK = 500

// A segment ending in one of these is not a sentence end: Intl.Segmenter's one
// real weakness is splitting after a title abbreviation ("Dr. Chen"), which the
// field repairs with a merge pass over the output rather than a different
// splitter. Decimals and "e.g."/"i.e." it already handles.
const TITLE = /\b(?:mr|mrs|ms|dr|prof|sr|jr|st|rev|gen|sen|rep|gov|lt|col|sgt|capt|vs|fig|no|vol|pp)\.$/i

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("en", { granularity: "sentence" }) : undefined

// Sentence boundaries via Intl.Segmenter (ICU-backed, decimal-safe), with the
// merge pass that rejoins a title abbreviation to the sentence it wrongly split
// from. Falls back to the coarse SENTENCE regex where Intl.Segmenter is absent.
function segment(text: string) {
  if (!segmenter) return sentences(text)
  const out: string[] = []
  for (const { segment } of segmenter.segment(text)) {
    const prev = out[out.length - 1]
    if (prev && TITLE.test(prev.trimEnd())) out[out.length - 1] = prev + segment
    else out.push(segment)
  }
  return out
}

// The rewrite path uses this instead of chunks(): the LLM already produced clean
// paragraph-structured prose (blank line between paragraphs, no atomic Table./
// Code block. regions), so it needs neither region-splitting nor the per-newline
// flush that fragmented list-shaped text into a chunk per line. This is the
// established streaming-TTS design: split into sentences, MERGE short ones up to
// a floor, never split a sentence (only an over-long one, at clauses then
// words), force a break at every blank-line paragraph, and keep the first chunk
// small for a fast start.
function proseChunks(text: string) {
  const out: string[] = []
  let held = ""
  // The first chunk aims small (fast first audio); every chunk after it aims
  // larger, since it is prefetched while the previous one plays.
  const target = () => (out.length ? MIN_CHUNK : FIRST_CHUNK)
  const flush = () => {
    const clean = held.replace(/\s+/g, " ").trim()
    held = ""
    if (clean) out.push(clean)
  }
  const add = (piece: string) => {
    const s = piece.trim()
    if (!s) return
    // An over-long sentence is the only thing split below the sentence level:
    // at clause punctuation first, then at word boundaries, never mid-word.
    if (s.length > MAX_CHUNK) {
      flush()
      for (const clause of splitLong(s)) out.push(clause)
      return
    }
    if (held && held.length + 1 + s.length > MAX_CHUNK) flush()
    held = held ? `${held} ${s}` : s
    if (held.length >= target()) flush()
  }
  for (const paragraph of text.split(/\n\s*\n/)) {
    for (const sentence of segment(paragraph)) add(sentence)
    // A blank-line paragraph break is a real pause the rewrite placed on
    // purpose, so it always ends the current chunk.
    flush()
  }
  return out
}

// An over-long sentence, broken at clause punctuation and then at word
// boundaries so no piece exceeds the cap. A monster is never sent whole and a
// word is never cut.
function splitLong(sentence: string) {
  const out: string[] = []
  let held = ""
  const flush = () => {
    if (held.trim()) out.push(held.trim())
    held = ""
  }
  for (const clause of sentence.split(/(?<=[,;:])\s+/)) {
    if (held && held.length + 1 + clause.length > MAX_CHUNK) flush()
    if (clause.length > MAX_CHUNK) {
      flush()
      for (const word of clause.split(/\s+/)) {
        if (held && held.length + 1 + word.length > MAX_CHUNK) flush()
        held = held ? `${held} ${word}` : word
      }
      continue
    }
    held = held ? `${held} ${clause}` : clause
  }
  flush()
  return out
}

// How much the cap rises per chunk. Synthesis is linear in length and the
// sidecar renders one chunk at a time, so a chunk arrives in time only when the
// chunk playing now lasts longer than the next takes to render. The slowest
// machine measured renders at half of realtime, making 2.0 the break-even
// multiple; below that leaves margin for a listener who has raised the playback
// rate, which shortens the cover without changing the cost.
//
// It multiplies the previous BUDGET rather than the previous chunk's length.
// Chunks end on sentence boundaries, so a length is quantized and usually well
// under the cap that admitted it; ramping on the length reaches a fixed point
// where the cap can never admit a second sentence, and every chunk in a long
// reading stays a single sentence.
const GROWTH = 1.5

// The same bound applied to what a chunk actually says rather than to the cap
// it was given, since that is the time the chunk after it has to render in.
//
// Slightly above two because chunk lengths are quantized to whole sentences: a
// one-sentence chunk can only be followed by one or two, and two is a shade over
// double once the separator is counted. At exactly two the budget settles one
// character below what a second sentence needs and every chunk in the reading
// stays a single sentence.
const COVER = 2.05

// A period followed by a digit is a decimal point rather than a sentence end,
// so the terminator does not match there: splitting reads "39.5s" as two
// sentences and the voice stops in the middle of a figure.
const SENTENCE = /(?:[^.!?\n]|\.(?=\d))*(?:[.!?]+|\n+|$)/g

export const sentences = (text: string) => text.match(SENTENCE)?.filter(Boolean) ?? []

function chunks(text: string, budget: number) {
  const parts = sentences(text)
  const out: string[] = []
  // A chunk is handed to a speech engine, where a line break carries nothing a
  // space does not. Collapsing here keeps the boundary decision below free to
  // use newlines without them surviving into what is spoken.
  // Two bounds, and the tighter one wins. The ramp lets the cap climb toward
  // CHUNK across a reading, while the emitted length holds it to what this
  // chunk will really cover: a chunk that lands well under its cap buys less
  // time than the cap implies, and only the second bound sees that.
  const push = (value: string) => {
    const clean = value.replace(/\s+/g, " ").trim()
    if (!clean) return
    out.push(clean)
    budget = Math.min(CHUNK, Math.round(budget * GROWTH), Math.round(clean.length * COVER))
  }
  let held = ""
  const flush = () => {
    push(held)
    held = ""
  }
  for (const sentence of parts) {
    if (sentence.length > budget) {
      flush()
      // Filling each piece to the budget would leave whatever is left over as
      // the last one, and a remainder far shorter than its predecessors is over
      // before the chunk after it has rendered. Spreading the sentence evenly
      // across the pieces it needs keeps every one of them able to cover the
      // next.
      const pieces = Math.ceil(sentence.length / budget)
      const even = Math.ceil(sentence.length / pieces)
      let run = ""
      for (const word of sentence.split(/\s+/)) {
        if (run && (run + " " + word).length > even) {
          push(run)
          run = word
          continue
        }
        run = (run + " " + word).trim()
      }
      held = run
      continue
    }
    if ((held + sentence).length > budget) flush()
    held += sentence
    // A line break ends a heading, a bullet, or a list item — none of which
    // run on into the next. Ending the chunk here is what puts a spoken pause
    // between them instead of reading a list as one breathless sentence.
    if (sentence.endsWith("\n")) flush()
  }
  flush()
  return { out, budget }
}

const OPENING = 90

// `skipSpeakable` is set when the text is already rewritten prose from the
// server: the LLM pass owns cleansing, so running the deterministic speakable()
// over it would be a second, competing cleaner.
export function toSpeech(markdown: string, skipSpeakable = false) {
  // The rewrite path is clean paragraph prose, chunked by the streaming-TTS
  // aggregation design; the fallback path is deterministic speakable() output
  // with atomic Table./Code block. regions, chunked by the region+ramp path.
  if (skipSpeakable) return proseChunks(markdown)
  const out: string[] = []
  let budget = OPENING
  for (const part of regions(speakable(markdown))) {
    // A table or code block is one utterance by design, since splitting it
    // would make a single skip land inside it rather than past it. It still
    // advances the ramp, because the time spent speaking it is cover like any
    // other chunk's.
    if (part.atomic) {
      out.push(part.value.replace(/\s+/g, " "))
      budget = Math.min(CHUNK, Math.round(budget * GROWTH))
      continue
    }
    const chunked = chunks(part.value, budget)
    out.push(...chunked.out)
    budget = chunked.budget
  }
  return out
}

// One reading at a time across the whole app: a second speak button starts a
// new reading rather than two voices overlapping.
let active: (() => void) | undefined

// fetch() sends Accept: */* and would take whatever the server defaults to, so
// the container this browser can actually decode is declared rather than left
// to a default. WAV is the fallback because it needs no encoder on either end,
// which is what makes it the one format every client is guaranteed to play.
export function accept(probe = document.createElement("audio")) {
  if (probe.canPlayType('audio/ogg; codecs="opus"')) return "audio/ogg"
  return "audio/wav"
}

// Identifies this listener's reading to the sidecar, which holds its rendered
// audio under this key and frees it when the reading ends.
const LISTENER = Math.random().toString(36).slice(2)

// Server-side synthesis means every client hears the same voice, which the
// platform speech engines cannot offer: their quality ranges from good on Apple
// to absent on Linux. The cost is a round trip, which the prefetch below keeps
// off the critical path. `next` rides along so the sidecar renders the chunk
// after this one while this one plays.
async function fetchAudio(base: string, text: string, next: string | undefined, signal: AbortSignal) {
  const response = await fetch(`${base}/tts/speak`, {
    method: "POST",
    body: JSON.stringify({ text, next }),
    headers: { "content-type": "application/json", accept: accept(), "x-speech-session": LISTENER },
    signal,
  })
  if (!response.ok) throw new Error(`speech failed: ${response.status}`)
  return URL.createObjectURL(await response.blob())
}

// Chunks are fetched one at a time, each while the one before it plays, so a
// reading only ever downloads what it is about to say: stopping early wastes a
// single chunk rather than a whole message's audio. The extra requests cost
// nothing in radio wake-ups, since the app already holds an SSE stream open for
// the whole session.
//
// Fetching further ahead than this makes stalls WORSE rather than better: the
// sidecar renders strictly one chunk at a time, so a request for a later chunk
// queues in front of the one that is due next. Measured at 3.4s of total
// silence one ahead, 7.6s at two, 9.0s at three. What keeps the pipeline fed is
// the size ramp in the chunker, not depth here.

// One silent PCM sample, inline so that unlocking costs no request. Playing it
// is what converts the gesture into a lasting permission on the element.
const SILENCE = "data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQIAAAAAAA=="

// How far into each message the listener got, keyed by the message's own text.
// Kept outside any one reading so returning to a message read earlier still
// offers to resume it, not only the most recent one. Deliberately in memory
// only: where someone stopped listening is worth nothing after a reload, and
// persisting it would mean writing a store and pruning it forever.
const progress = new Map<string, number>()

// A bound on remembered positions: the map would otherwise hold every message
// read for the life of the tab.
const REMEMBERED = 50

function remember(text: string, at: number) {
  progress.delete(text)
  progress.set(text, at)
  for (const key of progress.keys()) {
    if (progress.size <= REMEMBERED) break
    progress.delete(key)
  }
}

export function createSpeech(opts?: {
  url?: () => string
  session?: () => string
  directory?: () => string
  onDone?: () => void
  onError?: (message: string) => void
}) {
  const [store, setStore] = createStore({
    speaking: false,
    paused: false,
    loading: false,
    rate: storedRate(),
    index: 0,
    total: 0,
    // The words currently being voiced, so the HUD shows what is being read
    // rather than only how far along it is.
    chunk: "",
    // Set while the overlay is open with nothing playing, which is what lets it
    // offer resume-or-restart before any audio is fetched.
    armed: false,
    // Reactive because a message box reads it during render to tell whether the
    // reading on screen is its own.
    source: "",
  })

  const supported = () => typeof window !== "undefined" && typeof Audio !== "undefined"

  let queue: string[] = []
  // Holds the object URL of every chunk this reading fetched, keyed by chunk
  // index, so they can all be revoked when the reading ends.
  let cache = new Map<number, string>()
  // The chunk to play next. It OUTLIVES a stop, so pressing speak again on the
  // same message continues where the listener left off rather than restarting a
  // long reading they had already heard most of.
  let cursor = 0
  // ONE element for the whole reading, reused by swapping src. iOS grants
  // playback to the element that a user gesture touched, and only that one, so
  // a second element created later for the next segment is refused with
  // NotAllowedError. Reusing this one carries the grant across the whole queue.
  let player: HTMLAudioElement | undefined
  let abort: AbortController | undefined
  // A reading stopped mid-fetch must not start playing when its audio lands; a
  // resumed continuation compares this to know it was superseded.
  let epoch = 0

  const release = () => {
    for (const url of cache.values()) URL.revokeObjectURL(url)
    cache = new Map()
    const base = opts?.url?.() ?? ""
    // The sidecar holds rendered audio per listener until told the reading is
    // over, so a reading that never says so occupies it until eviction.
    fetch(`${base}/tts/done`, { method: "POST", headers: { "x-speech-session": LISTENER } }).catch(() => {})
  }

  // Whatever the device was already playing is interrupted for the reading and
  // resumes after it, which the OS only does when the session is handed back.
  // Holding "playback" past the last chunk leaves music paused indefinitely.
  const session = (type: "playback" | "auto") => {
    const audio = (navigator as { audioSession?: { type: string } }).audioSession
    if (audio) audio.type = type
  }

  // `reached` distinguishes a reading that ran out of chunks from one the
  // listener stopped: the first rewinds so the next press starts over, the
  // second leaves the cursor where it was so the next press resumes.
  const finish = (reached = false) => {
    if (store.source) remember(store.source, reached ? 0 : cursor)
    if (active === stop) active = undefined
    epoch++
    abort?.abort()
    abort = undefined
    if (player) {
      player.pause()
      player.onended = null
      player.onerror = null
      // The element is kept, not discarded: its playback permission was granted
      // by a gesture that will not happen again, and a fresh element for the
      // next reading would have to earn it from scratch.
      player.removeAttribute("src")
      player.load()
    }
    if (reached) release()
    session("auto")
    if (reached) cursor = 0
    // The HUD stays up when a reading is stopped rather than finished, so its
    // buttons remain available to resume or move to another chunk.
    setStore({ speaking: false, paused: false, loading: false, armed: !reached, chunk: reached ? "" : store.chunk })
    if (reached) opts?.onDone?.()
  }

  const stop = () => finish()

  // Playback permission is granted to an element inside a user gesture and is
  // lost across an await, so the element is created and started on a silent
  // source while the click is still on the stack. Every later segment then only
  // swaps src on this already-permitted element.
  const unlock = () => {
    const audio = player ?? new Audio()
    player = audio
    audio.preservesPitch = true
    audio.src = SILENCE
    audio.play().catch(() => {})
    return audio
  }

  // Plays one audio URL and resolves when it ends, so the caller sequences the
  // reading rather than each segment knowing what follows it.
  const play = (url: string, label: string, at: number) =>
    new Promise<void>((resolve, reject) => {
      const audio = player
      if (!audio) return reject(new Error("no audio element"))
      // Rate is a property of playback here rather than of synthesis, so a
      // speed change applies to audio already in flight.
      audio.playbackRate = store.rate
      audio.onended = () => resolve()
      audio.onerror = () => reject(new Error("audio playback failed"))
      audio.src = url
      setStore({ index: at, chunk: label, loading: false })
      audio.play().catch(reject)
    })

  // The whole raw message rewritten into speakable chunks. The server rewrites
  // the markdown into natural prose (owning cleansing, so speakable() is
  // skipped), and only the FALLBACK — an empty/failed rewrite that comes back
  // as the original text — runs the deterministic speakable() path. The result
  // is memoized per raw text so a resume or restart of the same message does not
  // pay for the rewrite twice within this reading.
  const built = new Map<string, string[]>()
  const queueFor = async (raw: string) => {
    const cached = built.get(raw)
    if (cached) return cached
    const base = opts?.url?.() ?? ""
    const sessionID = opts?.session?.() ?? ""
    const prose = await fetch(`${base}/tts/prepare`, {
      method: "POST",
      body: JSON.stringify({ text: raw, sessionID }),
      // The directory scopes the rewrite's instance context server-side, the
      // same header the SDK client sends on every other request.
      headers: { "content-type": "application/json", "x-opencode-directory": opts?.directory?.() ?? "" },
    })
      .then((r) => (r.ok ? r.json() : undefined))
      .then((body) => body?.text as string | undefined)
      .catch(() => undefined)
    // No rewrite (or it returned the input unchanged) means the deterministic
    // path; a real rewrite skips speakable() since the model already cleansed it.
    const out = prose && prose !== raw ? toSpeech(prose, true) : toSpeech(raw)
    built.set(raw, out)
    return out
  }

  // The speaker button on a message calls this. A message never heard before
  // has one obvious action, so it just plays; one with a remembered position
  // has two, so the HUD opens on that chunk and waits rather than guessing
  // between resuming and starting over.
  const show = async (text: string) => {
    if (!supported()) return
    const held = progress.get(text)
    active?.()
    active = stop
    // source stays the RAW text so resume-progress keys are stable regardless of
    // how the message was rewritten.
    setStore("source", text)
    if (held === undefined) return start()
    setStore({ armed: true, speaking: false, paused: false, loading: true, chunk: "" })
    queue = await queueFor(text)
    if (store.source !== text) return
    cursor = Math.min(held, Math.max(queue.length - 1, 0))
    setStore({
      armed: true,
      loading: false,
      total: queue.length,
      index: cursor,
      chunk: queue[cursor] ?? "",
    })
  }

  const start = async (text?: string) => {
    if (!supported()) return
    const reading = text ?? store.source
    active?.()
    active = stop
    const generation = ++epoch
    abort = new AbortController()
    const signal = abort.signal
    const base = opts?.url?.() ?? ""

    setStore({ armed: false, speaking: true, paused: false, loading: true, chunk: "" })
    // Unlock BEFORE the rewrite await: playback permission is granted to the
    // element inside the user gesture and lost across an await, so the silent
    // sample must play while the click is still on the stack — before the
    // rewrite round-trip, not after it.
    session("playback")
    unlock()

    // A different message restarts; the same one continues from where it
    // stopped. Building the queue is async now (the server rewrite), so it is
    // awaited here rather than computed synchronously.
    if (reading !== store.source || !queue.length) {
      setStore("source", reading)
      queue = await queueFor(reading)
      if (generation !== epoch) return
      cursor = progress.get(reading) ?? 0
    }
    if (!queue.length) return finish(true)
    if (cursor >= queue.length) cursor = 0
    setStore({ total: queue.length, index: cursor })

    // Nothing awaits a prefetch until its chunk is due, so it carries its own
    // catch: stopping mid-flight aborts it, and an unhandled rejection would
    // surface as a console error.
    const prefetch = (at: number) => {
      if (at >= queue.length) return undefined
      return fetchAudio(base, queue[at]!, queue[at + 1], signal)
        .then((url) => {
          cache.set(at, url)
          return url
        })
        .catch(() => "")
    }

    try {
      let pending = prefetch(cursor)
      let at = cursor
      while (at < queue.length) {
        const url = await pending
        if (generation !== epoch) return
        if (!url) return finish()
        // Queued before this chunk plays, so the next one is generated and
        // downloaded during audio the user is already hearing.
        pending = prefetch(at + 1)
        await play(url, queue[at]!, at)
        if (generation !== epoch) return
        at++
        cursor = at
        remember(store.source, at)
        setStore("loading", true)
      }
      finish(true)
    } catch (error) {
      if (generation !== epoch) return
      if (signal.aborted) return
      opts?.onError?.(error instanceof Error ? error.message : String(error))
      finish()
    }
  }

  const pause = () => {
    if (!store.speaking || store.paused) return
    player?.pause()
    setStore("paused", true)
  }

  const resume = () => {
    if (!store.speaking || !store.paused) return
    player?.play().catch(() => {})
    setStore("paused", false)
  }

  // Real audio has a playback rate, so a speed change is applied to the element
  // in flight and never re-fetches or restarts what is already playing.
  const setRate = (rate: number) => {
    const next = clampRate(rate)
    setStore("rate", next)
    if (player) player.playbackRate = next
    try {
      window.localStorage.setItem(RATE_KEY, String(next))
    } catch {}
  }

  const faster = () => setRate(store.rate + RATE.step)
  const slower = () => setRate(store.rate - RATE.step)

  // Moving to another chunk always stops the audio: the listener navigated to
  // look, and speaking over that would carry them past what they were reaching
  // for. Play is theirs to press once the HUD is on the chunk they wanted.
  const seek = (to: number) => {
    if (!queue.length) return
    if (store.speaking) finish()
    cursor = Math.max(0, Math.min(to, queue.length - 1))
    remember(store.source, cursor)
    setStore({ armed: true, index: cursor, chunk: queue[cursor] ?? "" })
  }

  const next = () => seek(cursor + 1)
  const previous = () => seek(cursor - 1)
  const restart = () => seek(0)

  const close = () => {
    finish()
    setStore({ armed: false, chunk: "" })
    opts?.onDone?.()
  }

  onCleanup(() => {
    if (active === stop) finish()
  })

  return {
    supported,
    speaking: () => store.speaking,
    paused: () => store.paused,
    loading: () => store.loading,
    armed: () => store.armed,
    open: () => store.armed || store.speaking,
    reading: (text: string) => (store.armed || store.speaking) && text === store.source,
    rate: () => store.rate,
    index: () => store.index,
    total: () => store.total,
    chunk: () => store.chunk,
    resuming: () => store.index > 0,
    show,
    start,
    stop,
    close,
    pause,
    resume,
    seek,
    next,
    previous,
    restart,
    faster,
    slower,
  }
}
