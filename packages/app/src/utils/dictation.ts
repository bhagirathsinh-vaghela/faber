import { onCleanup } from "solid-js"
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

function encode(samples: Float32Array) {
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    pcm[i] = Math.max(-1, Math.min(1, samples[i])) * 32767
  }
  return pcm.buffer
}

let active: (() => void) | undefined

// True while any dictation session (from any host) is capturing. Not
// reactive: for one-shot checks like whether a newly-mounted panel should
// grab focus.
export const dictationActive = () => !!active

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

  const supported = () => !!navigator.mediaDevices?.getUserMedia

  const teardown = () => {
    if (!session) return
    const { socket, context, stream } = session
    session = undefined
    analyser = undefined
    if (active === stop) active = undefined
    setStore("active", false)
    for (const track of stream.getTracks()) track.stop()
    context.close()
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "stop" }))
    socket.close()
  }

  const stop = () => teardown()

  const text = () => [store.committed, store.interim].filter(Boolean).join(" ")

  const start = async () => {
    if (session) return
    active?.()
    active = stop
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      })
      const context = new AudioContext({ sampleRate: 16000 })
      if (context.sampleRate !== 16000) {
        for (const track of stream.getTracks()) track.stop()
        context.close()
        throw new Error(`AudioContext sample rate is ${context.sampleRate}, expected 16000`)
      }
      await context.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })))

      const url = new URL(opts.url() + "/dictation/connect")
      if (window.__OPENCODE__?.serverPassword) {
        url.username = "opencode"
        url.password = window.__OPENCODE__.serverPassword
      }
      const socket = new WebSocket(url)
      socket.binaryType = "arraybuffer"
      session = { socket, context, stream }
      setStore({ active: true, committed: "", interim: "" })

      const pending: ArrayBuffer[] = []
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
        if (session?.socket === socket) teardown()
      }
    } catch (error) {
      if (active === stop) active = undefined
      setStore("active", false)
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
