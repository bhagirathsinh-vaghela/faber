import { createEffect, createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"

// Worklet source is inlined via a Blob URL so no separate asset has to flow
// through the embedded web bundle pipeline.
const WORKLET = `
class DictationCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = []
    this.length = 0
  }
  process(inputs) {
    const channel = inputs[0]?.[0]
    if (!channel) return true
    this.buffer.push(channel.slice())
    this.length += channel.length
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

// Releasing the capture graph is slow: track.stop() and AudioContext.close()
// tear down the OS audio path, and over a Bluetooth headset that also forces the
// HFP->A2DP profile switch, which blocks the main thread for hundreds of ms.
// Deferring it past the paint keeps that cost off the frame that dismisses the
// overlay and inserts the transcript. The socket closes first so the server-side
// transcription stream ends immediately rather than outliving the audio.
function release(socket: WebSocket, context: AudioContext, stream: MediaStream) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "stop" }))
  socket.close()
  afterPaint(() => {
    for (const track of stream.getTracks()) track.stop()
    context.close().catch(() => {})
  })
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

  const supported = () => !!navigator.mediaDevices?.getUserMedia

  const teardown = () => {
    epoch++
    abortStart?.()
    if (!session) return
    const { socket, context, stream } = session
    session = undefined
    analyser = undefined
    if (active === stop) active = undefined
    setStore({ active: false, committed: "", interim: "" })
    release(socket, context, stream)
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
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      })
      if (generation !== epoch) {
        dispose()
        return
      }
      context = new AudioContext({ sampleRate: 16000 })
      if (context.sampleRate !== 16000) {
        throw new Error(`AudioContext sample rate is ${context.sampleRate}, expected 16000`)
      }
      await context.audioWorklet.addModule(workletModule())
      if (generation !== epoch) {
        dispose()
        return
      }
      if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
        throw new Error("Dictation connection closed")
      }

      session = { socket, context, stream }
      abortStart = undefined
      setStore("active", true)

      const worklet = new AudioWorkletNode(context, "dictation-capture")
      worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
        const frame = encode(event.data)
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(frame)
          return
        }
        if (socket.readyState === WebSocket.CONNECTING) pending.push(frame)
      }
      const source = context.createMediaStreamSource(stream)
      source.connect(worklet)

      // Waveform reads this analyser's frequency data on its own rAF.
      analyser = context.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.8
      source.connect(analyser)
    } catch (error) {
      if (session?.socket === socket) {
        session = undefined
        analyser = undefined
      }
      dispose()
      if (active === stop) active = undefined
      setStore("active", false)
      if (generation !== epoch) return
      opts.onError?.(error instanceof Error ? error.message : String(error))
    }
  }

  onCleanup(teardown)

  return {
    supported,
    active: () => store.active,
    committed: () => store.committed,
    interim: () => store.interim,
    analyser: () => analyser,
    text,
    start,
    stop,
  }
}
