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

// Transcript accumulates in the store (finals append to committed, interims
// replace) and is only handed to the host on an explicit accept; stop()
// discards. The host renders committed/interim live and decides.
const LEVEL_BARS = 24

export function createDictation(opts: { url: () => string; onError?: (message: string) => void }) {
  const [store, setStore] = createStore({
    active: false,
    committed: "",
    interim: "",
    levels: Array.from({ length: LEVEL_BARS }, () => 0),
  })

  let session: { socket: WebSocket; context: AudioContext; stream: MediaStream } | undefined
  let raf = 0

  const supported = () => !!navigator.mediaDevices?.getUserMedia

  const teardown = () => {
    if (!session) return
    const { socket, context, stream } = session
    session = undefined
    if (active === stop) active = undefined
    cancelAnimationFrame(raf)
    setStore({ active: false, levels: store.levels.map(() => 0) })
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

      // Speech indicator: sample the analyser each frame into a scrolling bar
      // strip (newest level enters on the right).
      const analyser = context.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.6
      source.connect(analyser)
      const samples = new Float32Array(analyser.fftSize)
      const pump = () => {
        if (!session) return
        analyser.getFloatTimeDomainData(samples)
        let sum = 0
        for (const sample of samples) sum += sample * sample
        const level = Math.min(1, Math.sqrt(sum / samples.length) * 6)
        setStore("levels", [...store.levels.slice(1), level])
        raf = requestAnimationFrame(pump)
      }
      raf = requestAnimationFrame(pump)

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
    levels: () => store.levels,
    text,
    start,
    stop,
  }
}
