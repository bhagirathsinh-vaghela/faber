import { Log } from "../util/log"
import { DictationRate } from "./rate"
import type { Engine, Host } from "./engine"

const log = Log.create({ service: "dictation.local" })

export function local(host: Host, url: string): Engine {
  const frames: ArrayBuffer[] = []
  let closed = false

  return {
    frame(data) {
      frames.push(data)
    },
    // The whole utterance goes to the model in one piece: splitting it costs
    // the context that disambiguates words at the boundary, which is the
    // accuracy this engine was chosen for.
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
      const audio = new Blob(frames)
      const bytes = audio.size
      frames.length = 0
      const began = Date.now()
      const response = await fetch(`${url}/transcribe`, {
        method: "POST",
        body: audio,
        headers: { "content-type": "application/octet-stream" },
      }).catch((error) => {
        log.error("sidecar unreachable", { url, error })
        return undefined
      })
      if (closed) return
      if (!response?.ok) {
        host.fail(`Local transcription failed — is the sidecar running at ${url}?`)
        return
      }
      const transcribed = await response.json()
      log.info("transcribed", { ms: Date.now() - began, engine: transcribed.ms, bytes })
      if (closed) return
      if (transcribed.text) host.transcript({ text: transcribed.text, final: true })
      host.done()
    },
    close() {
      closed = true
      frames.length = 0
    },
  }
}
