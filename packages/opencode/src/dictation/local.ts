import { retry } from "@opencode-ai/util/retry"
import { Log } from "../util/log"
import { DictationRate } from "./rate"
import type { Engine, Host } from "./engine"

const log = Log.create({ service: "dictation.local" })

// A restarting sidecar refuses connections for about a second, so a single
// failed POST is almost always transient. Retrying holds the audio across that
// window instead of losing the user's speech to a momentary gap.
const TRANSCRIBE_ATTEMPTS = 3
const TRANSCRIBE_BACKOFF_MS = 400

// A sidecar that accepts a POST and never answers would hold the dictation, and
// a recovery pull waiting on it, forever. Each attempt gets this long plus the
// chunk's length in real time at the default rate, which over-allows a model
// sampling faster.
const TRANSCRIBE_TIMEOUT_MS = 30_000

// Ceiling on audio held for one chunk before it is transcribed regardless of a
// pause. Without it a mic left open streams into an unbounded buffer. The byte
// budget is that duration of mono PCM16 at the default rate; a model sampling
// faster reaches it sooner.
const MAX_BUFFER_MS = 600_000
const MAX_BUFFER_BYTES = (DictationRate.DEFAULT * 2 * MAX_BUFFER_MS) / 1000

// A committed chunk's audio was cut off from its neighbours at a pause, so a
// leading boundary mark the decoder emits for it means nothing and is dropped.
function trim(text: string) {
  let out = text.trimStart()
  while (out[0] === "." || out[0] === ",") out = out.slice(1).trimStart()
  return out
}

export function local(host: Host, url: string, timeout = TRANSCRIBE_TIMEOUT_MS): Engine {
  const frames: ArrayBuffer[] = []
  let buffered = 0
  let closed = false
  // Flushes run one at a time: a commit's POST and the stop that follows it must
  // emit their chunks in capture order, so each awaits the previous rather than
  // racing on which response resolves first.
  let queue: Promise<boolean> = Promise.resolve(true)

  // Per-chunk POSTs need no cross-request reset: the sidecar decodes each
  // request from fresh state, so a committed chunk cannot inherit the previous
  // chunk's decoder state and emit a phantom boundary token.
  async function transcribe(audio: Blob) {
    const began = Date.now()
    // The same Blob is re-sent on each attempt, so a sidecar that comes back
    // mid-retry transcribes the audio the first attempt could not deliver.
    const response = await retry(
      async () => {
        const attempt = await fetch(`${url}/transcribe`, {
          method: "POST",
          body: audio,
          headers: { "content-type": "application/octet-stream" },
          signal: AbortSignal.timeout(timeout + (audio.size / (DictationRate.DEFAULT * 2)) * 1000),
        })
        if (!attempt.ok) throw new Error(`sidecar responded ${attempt.status}`)
        return attempt
      },
      { attempts: TRANSCRIBE_ATTEMPTS, delay: TRANSCRIBE_BACKOFF_MS, retryIf: () => !closed },
    ).catch((error) => {
      log.error("sidecar unreachable", { url, error })
      return undefined
    })
    if (closed) return false
    if (!response) {
      host.fail(`Local transcription failed — is the sidecar running at ${url}?`)
      return false
    }
    const transcribed = await response.json().catch((error) => {
      log.error("sidecar reply unreadable", { url, error })
      return undefined
    })
    if (closed) return false
    if (!transcribed) {
      host.fail(`Local transcription failed — the sidecar at ${url} sent an unreadable reply`)
      return false
    }
    log.info("transcribed", { ms: Date.now() - began, engine: transcribed.ms, bytes: audio.size })
    const text = trim(transcribed.text ?? "")
    if (text) host.transcript({ text, final: true })
    return true
  }

  function flush() {
    if (frames.length === 0) return queue
    // Snapshot the buffer now, so a chunk cannot absorb audio spoken after the
    // commit that closed it.
    const audio = new Blob(frames)
    frames.length = 0
    buffered = 0
    queue = queue.then((ok) => (ok ? transcribe(audio) : false))
    return queue
  }

  return {
    frame(data) {
      frames.push(data)
      buffered += data.byteLength
      // A never-committed chunk cannot grow without bound: flush it as its own
      // utterance once it reaches the cap, the same as a pause would.
      if (buffered >= MAX_BUFFER_BYTES) flush()
    },
    commit() {
      flush()
    },
    async stop(rate) {
      const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })
        .then((r) => (r.ok ? r.json() : undefined))
        .catch(() => undefined)
      if (closed) return
      if (health && typeof health.sampleRate === "number" && health.sampleRate !== rate) {
        DictationRate.set(health.sampleRate)
        host.fail("The dictation model changed. Please try again.")
        return
      }
      if (await flush()) host.done()
    },
    close() {
      closed = true
      frames.length = 0
      buffered = 0
    },
  }
}
