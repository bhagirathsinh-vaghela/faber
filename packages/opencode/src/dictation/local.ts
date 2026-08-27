import { Log } from "../util/log"
import { DictationRate } from "./rate"
import type { Engine, Host } from "./engine"

const log = Log.create({ service: "dictation.local" })

// A committed chunk's audio was cut off from its neighbours at a pause, so a
// leading boundary mark the decoder emits for it means nothing and is dropped.
function trim(text: string) {
  let out = text.trimStart()
  while (out[0] === "." || out[0] === ",") out = out.slice(1).trimStart()
  return out
}

export function local(host: Host, url: string): Engine {
  const frames: ArrayBuffer[] = []
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
    const response = await fetch(`${url}/transcribe`, {
      method: "POST",
      body: audio,
      headers: { "content-type": "application/octet-stream" },
    }).catch((error) => {
      log.error("sidecar unreachable", { url, error })
      return undefined
    })
    if (closed) return false
    if (!response?.ok) {
      host.fail(`Local transcription failed — is the sidecar running at ${url}?`)
      return false
    }
    const transcribed = await response.json()
    log.info("transcribed", { ms: Date.now() - began, engine: transcribed.ms, bytes: audio.size })
    if (closed) return false
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
    queue = queue.then((ok) => (ok ? transcribe(audio) : false))
    return queue
  }

  return {
    frame(data) {
      frames.push(data)
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
    },
  }
}
