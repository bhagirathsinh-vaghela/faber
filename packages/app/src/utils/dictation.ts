import { createEffect, createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"

// Worklet source is inlined via a Blob URL so no separate asset has to flow
// through the embedded web bundle pipeline.
const WORKLET = `
const TARGET = 16000
class DictationCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = []
    this.length = 0
    this.phase = 0
  }
  process(inputs) {
    const channel = inputs[0]?.[0]
    if (!channel) return true
    // WebKit may hand back a rate it chose rather than the one asked for, so
    // the wire rate is met here instead of being assumed. Averaging the samples
    // that collapse into one output low-passes them; taking a single sample
    // aliases voice back into the speech band.
    const step = sampleRate / TARGET
    const out = new Float32Array(Math.ceil((channel.length - this.phase) / step))
    let taken = 0
    for (let at = this.phase; at < channel.length; at += step) {
      const from = Math.floor(at)
      const to = Math.min(channel.length, Math.floor(at + step))
      let sum = 0
      for (let scan = from; scan < to; scan++) sum += channel[scan]
      out[taken++] = to > from ? sum / (to - from) : channel[from]
    }
    this.phase = this.phase + taken * step - channel.length
    this.buffer.push(out.subarray(0, taken))
    this.length += taken
    if (this.length >= 1024) {
      const merged = new Float32Array(this.length)
      let offset = 0
      for (const chunk of this.buffer) {
        merged.set(chunk, offset)
        offset += chunk.length
      }
      this.port.postMessage(merged, [merged.buffer])
      this.buffer = []
      this.length = 0
    }
    return true
  }
}
registerProcessor("dictation-capture", DictationCapture)
`

// Ceiling on how long a batch engine may take to return its transcript after
// the mic stops.
const DRAIN_MS = 30_000

// Upper bound on holding the capture graph open after the mic stops. The OS
// recording indicator is already dark by then, so this only bounds the wait
// for a transcript that may never arrive.
const AUDIO_RELEASE_MS = 2_000

function parse(data: unknown) {
  try {
    return JSON.parse(String(data)) as { type?: string; text?: string; final?: boolean; message?: string }
  } catch {
    return undefined
  }
}

let workletUrl: string | undefined
const workletModule = () => (workletUrl ??= URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })))

function encode(samples: Float32Array) {
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    pcm[i] = Math.max(-1, Math.min(1, samples[i])) * 32767
  }
  return pcm.buffer
}

// Run after the browser has committed the next paint. A rAF callback lands just
// before the frame is painted, so a task queued from inside it runs after. A
// hidden tab never fires rAF, so a timer races it — the mic must always be
// released, even with nothing on screen to wait for.
function afterPaint(fn: () => void) {
  let ran = false
  const once = () => {
    if (ran) return
    ran = true
    fn()
  }
  requestAnimationFrame(() => setTimeout(once))
  setTimeout(once, 500)
}

async function acquire() {
  // Nothing here depends on the microphone, so building the graph in parallel
  // takes its cost off the press instead of adding to it.
  // WebKit opens the route faster for an explicit 16kHz context than for a
  // native-rate one whose output has to be decimated afterwards.
  const context = new AudioContext({ sampleRate: 16000 })
  const ready = context.audioWorklet.addModule(workletModule())
  const stream = await navigator.mediaDevices
    // Echo cancellation and noise suppression put iOS on its voice-processing
    // audio unit, which costs most of a second to instantiate, and dictation
    // plays nothing back so there is no echo to cancel. Gain control is left on:
    // measured against this same script, disabling it both slowed acquisition
    // and cost a proper noun.
    .getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false } })
    .catch((error) => {
      context.close().catch(() => {})
      throw error
    })
  // The worklet decimates whatever arrives down to the wire rate, so a WebKit
  // that ignored the request is fine. Only a context slower than the target is
  // unusable: decimation can discard samples, never invent them.
  if (context.sampleRate < 16000) {
    for (const track of stream.getTracks()) track.stop()
    context.close().catch(() => {})
    throw new Error(`AudioContext sample rate is ${context.sampleRate}, below the 16000 dictation needs`)
  }
  // WebKit starts a context suspended when it is constructed outside the
  // gesture that began the press, and audio silently never flows.
  if (context.state !== "running") await context.resume().catch(() => {})
  await ready
  return { stream, context }
}

// The mic is never held past the dictation: an idle capture keeps the OS
// recording indicator lit, telling the user they are being listened to when
// they are not.
function release(socket: WebSocket, context: AudioContext, stream: MediaStream) {
  // The server closes once it has flushed the last transcript. A batch engine
  // only starts transcribing at "stop", so closing here would drop the result;
  // the timer covers a server that never closes.
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "stop" }))
    setTimeout(() => socket.close(), DRAIN_MS)
  } else socket.close()
  for (const track of stream.getTracks()) track.stop()
  // Closing competes for the same thread that dispatches the transcript, so the
  // caller runs this once the text has landed and the timer bounds the wait.
  let released = false
  const close = () => {
    if (released) return
    released = true
    afterPaint(() => context.close().catch(() => {}))
  }
  setTimeout(close, AUDIO_RELEASE_MS)
  return close
}

let active: (() => void) | undefined

// True while any dictation session (from any host) is capturing. Not
// reactive: for one-shot checks like whether a newly-mounted panel should
// grab focus.
export const dictationActive = () => !!active

// A dictation shortcut has to fire against exactly one mic, but two composers
// (the prompt dock and an expanded question panel) can show one at once. The
// focused composer registers itself as the target; the prompt dock also
// registers as the fallback, so the shortcut always has somewhere to land even
// when nothing is focused. `dictationTarget()` resolves focused-over-fallback,
// and each mic reads it to paint its focus ring.
type Target = { id: string; toggle: () => void }
const [focused, setFocused] = createSignal<Target>()
const [fallback, setFallback] = createSignal<Target>()

export const dictationTarget = () => focused() ?? fallback()

// Register a composer as the dictation target while its editor holds focus.
// `role: "fallback"` additionally claims the default slot for its lifetime, so
// the prompt dock stays the target whenever no composer is focused.
export function registerDictationTarget(target: Target, active: () => boolean, role?: "fallback") {
  if (role === "fallback") {
    setFallback(target)
    onCleanup(() => setFallback((current) => (current?.id === target.id ? undefined : current)))
  }
  createEffect(() => {
    if (!active()) return
    setFocused(target)
    onCleanup(() => setFocused((current) => (current?.id === target.id ? undefined : current)))
  })
}

// Transcript accumulates in the store (finals append to committed, interims
// replace) and is only handed to the host on an explicit accept; stop()
// discards. The host renders committed/interim live and decides.
export function createDictation(opts: { url: () => string; onError?: (message: string) => void }) {
  const [store, setStore] = createStore({
    active: false,
    // Audio only reaches the socket once the OS route opens, which trails the
    // press by up to a second on a cold start. Words spoken before that are
    // gone, so the overlay has to distinguish arming from listening.
    listening: false,
    // A batch engine transcribes only after the mic stops, so the overlay has
    // to keep rendering while the result is still in flight.
    transcribing: false,
    committed: "",
    interim: "",
  })

  let session: { socket: WebSocket; context: AudioContext; stream: MediaStream } | undefined
  // The live analyser drives the waveform canvas directly (its own rAF reads
  // frequency data), so per-frame audio levels never churn the Solid store.
  let analyser: AnalyserNode | undefined
  // stop() during start()'s awaits used to leave a hot mic with nothing on
  // screen: stop found no session yet, then start finished wiring one up. The
  // epoch lets a resumed start detect the intervening stop and release instead.
  let epoch = 0
  // Set while start() is between dialing the socket and committing a session.
  // A stop in that window has no session to release, but the socket is already
  // connected server-side; without this hook it stays open until getUserMedia
  // settles — minutes, when the user ignores the mic-permission prompt.
  let abortStart: (() => void) | undefined
  // Shared by concurrent settle() callers so the transcript is delivered once.
  let settling: Promise<string> | undefined

  const supported = () => !!navigator.mediaDevices?.getUserMedia

  const teardown = () => {
    epoch++
    abortStart?.()
    settling = undefined
    if (!session) return
    const { socket, context, stream } = session
    session = undefined
    analyser = undefined
    if (active === stop) active = undefined
    setStore({ active: false, listening: false, transcribing: false, committed: "", interim: "" })
    release(socket, context, stream)()
  }

  // Releases the microphone but leaves the socket open, since a batch engine
  // sends nothing until the audio ends. Resolves when the server closes.
  // Resolving transfers ownership of the transcript to the caller, so the
  // store is left empty for the next dictation. Concurrent callers (the
  // overlay's unmount and the host's own accept) share one promise, so the
  // transcript is delivered exactly once.
  const settle = () => {
    if (settling) return settling
    if (!session) {
      const transcript = text()
      setStore({ transcribing: false, committed: "", interim: "" })
      return Promise.resolve(transcript)
    }
    const { socket, context, stream } = session
    session = undefined
    analyser = undefined
    if (active === stop) active = undefined
    setStore({ active: false, listening: false, transcribing: true })
    const asked = performance.now()
    const closeAudio = release(socket, context, stream)
    settling = new Promise<string>((resolve) => {
      let done = false
      const settled = () => {
        if (done) return
        done = true
        const transcript = text()
        setStore({ transcribing: false, committed: "", interim: "" })
        settling = undefined
        resolve(transcript)
        closeAudio()
      }
      if (socket.readyState === WebSocket.CLOSED) return settled()
      // Whichever arrives first wins: a final transcript, the socket closing
      // without one, or the drain ceiling for a server that does neither.
      socket.addEventListener("close", settled, { once: true })
      socket.addEventListener("message", (event) => {
        const message = parse(event.data)
        if (message?.type !== "transcript" || message.final !== true) return
        queueMicrotask(settled)
      })
      setTimeout(settled, DRAIN_MS)
    })
    return settling
  }

  const stop = () => teardown()

  const text = () => [store.committed, store.interim].filter(Boolean).join(" ")

  const start = async () => {
    if (session) return
    active?.()
    active = stop
    const generation = ++epoch

    // Dial before touching the mic: the handshake crosses the network (a full
    // RTT or two on cellular) while getUserMedia and the worklet compile run
    // locally, so neither waits on the other. Audio produced before the socket
    // opens queues in `pending`.
    const url = new URL(opts.url() + "/dictation/connect")
    if (window.__OPENCODE__?.serverPassword) {
      url.username = "opencode"
      url.password = window.__OPENCODE__.serverPassword
    }
    const socket = new WebSocket(url)
    socket.binaryType = "arraybuffer"

    const pending: ArrayBuffer[] = []
    socket.onopen = () => {
      for (const frame of pending) socket.send(frame)
      pending.length = 0
    }
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data))
      if (message.type === "transcript") {
        if (message.final) {
          setStore({
            committed: store.committed ? store.committed + " " + message.text : message.text,
            interim: "",
          })
          return
        }
        setStore("interim", message.text)
        return
      }
      if (message.type === "error") {
        opts.onError?.(message.message)
        teardown()
      }
    }
    socket.onclose = () => {
      if (session?.socket !== socket) return
      // A network drop otherwise leaves the overlay rendering a live-looking
      // mic forever. Error before teardown: the host dismisses while the
      // transcript is still in the store, so its unmount stash keeps the text.
      opts.onError?.("Dictation connection closed")
      teardown()
    }

    let stream: MediaStream | undefined
    let context: AudioContext | undefined
    const dispose = () => {
      abortStart = undefined
      socket.onclose = null
      socket.close()
      if (stream) for (const track of stream.getTracks()) track.stop()
      context?.close().catch(() => {})
    }
    abortStart = dispose

    try {
      const graph = await acquire()
      stream = graph.stream
      context = graph.context
      if (generation !== epoch) {
        dispose()
        return
      }
      if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
        throw new Error("Dictation connection closed")
      }

      const worklet = new AudioWorkletNode(context, "dictation-capture")
      // Frames arrive before the audio route opens, so signal is what proves the
      // microphone is live and the user can safely start speaking.
      let silent = true
      worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (silent && event.data.some((sample) => sample !== 0)) {
          silent = false
          setStore("listening", true)
        }
        const frame = encode(event.data)
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(frame)
          return
        }
        if (socket.readyState === WebSocket.CONNECTING) pending.push(frame)
      }
      const source = context.createMediaStreamSource(stream)
      source.connect(worklet)

      // Waveform reads this analyser's frequency data on its own rAF. The gain
      // sits in front of it only: capture asks the OS for no auto-gain, so the
      // bars would otherwise read far quieter than the speech sounds. Nothing
      // downstream of the worklet sees this, so the model still gets the
      // untouched signal.
      analyser = context.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.8
      const visual = context.createGain()
      visual.gain.value = 4
      source.connect(visual)
      visual.connect(analyser)

      session = { socket, context, stream }
      abortStart = undefined
      setStore("active", true)
    } catch (error) {
      if (session?.socket === socket) {
        session = undefined
        analyser = undefined
      }
      dispose()
      if (active === stop) active = undefined
      setStore({ active: false, listening: false })
      if (generation !== epoch) return
      opts.onError?.(error instanceof Error ? error.message : String(error))
    }
  }

  onCleanup(teardown)

  return {
    supported,
    active: () => store.active,
    listening: () => store.listening,
    transcribing: () => store.transcribing,
    settle,
    analyser: () => analyser,
    start,
    stop,
  }
}
