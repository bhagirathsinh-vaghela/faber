import { createEffect, createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"

// Worklet source is inlined via a Blob URL so no separate asset has to flow
// through the embedded web bundle pipeline.
const WORKLET = `
class DictationCapture extends AudioWorkletProcessor {
  constructor(options) {
    super()
    // The wire rate the caller committed to. When the context already runs at
    // this rate (the common path, since the context is asked for exactly it),
    // frames pass straight through and the browser's own resampler did the
    // 48k->16k work at sinc quality. The decimator below runs only when the
    // engine ignored the requested rate and handed back a faster context.
    this.target = options.processorOptions.target
    this.buffer = []
    this.length = 0
    this.phase = 0
  }
  process(inputs) {
    const channel = inputs[0]?.[0]
    if (!channel) return true
    // Fast path: the context is already at the wire rate, so no resampling is
    // needed and none is done — the browser's polyphase resampler produced
    // these samples. Browser STT clients commonly rely on this.
    if (sampleRate === this.target) {
      this.buffer.push(channel.slice())
      this.length += channel.length
    } else {
      // Fallback for an engine that ignored the requested rate: a box-average
      // decimator. Averaging the samples that collapse into one output
      // low-passes them; taking a single sample would alias voice back into
      // the speech band. Lower quality than the browser resampler, but only
      // reached when the browser refused to give us the rate we asked for.
      const step = sampleRate / this.target
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
    }
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

// The rate every current model runs at, and the server's own default. The
// capture context is built at this immediately on the press — inside the
// user-gesture window, where AudioContext.resume() must run on iOS — instead
// of waiting for the server to name a rate. The server's rate message still
// arrives and is honored: on the rare occasion it differs (a model changed),
// the graph is rebuilt at the rate it names.
const DEFAULT_RATE = 16000

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

// The browser's voice-processing DSP (echo cancellation, noise suppression,
// auto gain) is tuned for two-way calls on quiet built-in mics. On a good
// external mic it HURTS recognition — noise suppression clips consonants, AGC
// pumps levels, echo cancellation subtracts parts of the speaker's own voice —
// and the damage is at capture, so the server can never recover it. The flags
// are therefore a per-device runtime choice: off ("raw") for a good mic, on
// ("enhanced") for a quiet built-in one.
//
// Every client defaults to raw. A user on a quiet built-in mic flips to
// enhanced, and that choice persists per-device and wins here. On WebKit the
// three flags are coupled — turning echoCancellation off ALSO turns AGC off —
// so "enhanced" is the only way to restore AGC for a mic that captures too
// quiet. openMic reads the flag fresh, so a switch lands on the next capture.
const DSP_KEY = "opencode.dictation.enhanced"

const [enhanced, setEnhancedSignal] = createSignal(
  (() => {
    try {
      return localStorage.getItem(DSP_KEY) === "on"
    } catch {}
    return false
  })(),
)

// Whether the browser DSP chain is engaged. Reactive so the dock preferences
// toggle paints live; read by openMic at capture time so a flip lands on the next mic.
export const dictationEnhanced = enhanced

export function setDictationEnhanced(next: boolean) {
  setEnhancedSignal(next)
  try {
    localStorage.setItem(DSP_KEY, next ? "on" : "off")
  } catch {}
}

// Opens the microphone route without waiting on anything else. This is the
// slow step on iOS (its voice-processing audio unit costs most of a second),
// and it depends on nothing the server sends, so the caller fires it the
// instant the press lands — before the socket handshake and the wire-rate
// round-trip — rather than stacking it behind them.
function openMic() {
  const dsp = enhanced()
  return navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: dsp, noiseSuppression: dsp, autoGainControl: dsp },
  })
}

// Builds the capture context at the target rate. Requesting the target rate
// gets the browser's own polyphase resampler for the 48k->16k step (sinc
// quality), which browser STT clients commonly rely on; the
// worklet only decimates if the browser ignored the request. Called in-gesture
// so the resume() below lands inside the user-activation window iOS requires.
async function acquire(target: number, mic: Promise<MediaStream>) {
  const context = new AudioContext({ sampleRate: target })
  // Fire the module load and the resume() NOW, synchronously in the gesture,
  // before awaiting anything. iOS starts a context suspended and only honors a
  // resume() issued inside the activation window; issuing it after `await mic`
  // would land outside that window and audio would silently never flow.
  const ready = context.audioWorklet.addModule(workletModule())
  const resumed = context.state === "running" ? Promise.resolve() : context.resume().catch(() => {})
  const stream = await mic.catch((error) => {
    context.close().catch(() => {})
    throw error
  })
  // The worklet decimates whatever arrives down to the wire rate, so a browser
  // that ignored the request is fine. Only a context slower than the target is
  // unusable: decimation can discard samples, never invent them.
  if (context.sampleRate < target) {
    for (const track of stream.getTracks()) track.stop()
    context.close().catch(() => {})
    throw new Error(`AudioContext sample rate is ${context.sampleRate}, below the ${target} dictation needs`)
  }
  await resumed
  await ready.catch((error) => {
    for (const track of stream.getTracks()) track.stop()
    context.close().catch(() => {})
    throw error
  })
  return { stream, context }
}

// The mic is never held past the dictation: an idle capture keeps the OS
// recording indicator lit, telling the user they are being listened to when
// they are not.
function release(socket: WebSocket, context: AudioContext, stream: MediaStream, rate: number) {
  // The server closes once it has flushed the last transcript. A batch engine
  // only starts transcribing at "stop", so closing here would drop the result;
  // the timer covers a server that never closes.
  if (socket.readyState === WebSocket.OPEN) {
    // The captured rate rides along so the server can reject it when a model
    // change has made it stale rather than transcribe garbled audio.
    socket.send(JSON.stringify({ type: "stop", rate }))
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

// Ends a dictation without asking for a transcript: the socket closes instead
// of sending "stop", so the server drops the audio rather than paying an engine
// run for text nobody will read. The handlers are cleared first because a
// transcript already in flight would otherwise land in the store after the
// discard.
function abort(socket: WebSocket, context: AudioContext, stream: MediaStream) {
  socket.onmessage = null
  socket.onclose = null
  socket.close()
  for (const track of stream.getTracks()) track.stop()
  afterPaint(() => context.close().catch(() => {}))
}

let active: (() => void) | undefined

// True while any dictation session (from any host) is capturing. Not
// reactive: for one-shot checks like whether a newly-mounted panel should
// grab focus.
export const dictationActive = () => !!active

// The reactive twin, for a mic that has to paint its own capturing state while
// the host owning the session is somewhere else (the reader pill, whose
// composer is not rendered).
const [dictating, setDictating] = createSignal(false)
export const dictationRunning = dictating

// Every assignment to `active` goes through here, so the two cannot disagree.
const setActive = (next: (() => void) | undefined) => {
  active = next
  setDictating(!!next)
}

// A dictation shortcut has to fire against exactly one mic, but two composers
// (the prompt dock and an expanded question panel) can show one at once. The
// focused composer registers itself as the target; the prompt dock also
// registers as the fallback, so the shortcut always has somewhere to land even
// when nothing is focused. `dictationTarget()` resolves focused-over-fallback,
// and each mic reads it to pick its tint.
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
// replace) and reaches the host through settle() (an accept, or the overlay
// unmounting) or, after a dropped connection, through onRecovered; stop()
// discards. The host renders committed/interim live and decides.
export function createDictation(opts: {
  url: () => string
  onError?: (message: string) => void
  // Pulls the transcript the server held after an unexpected drop. The consumer
  // owns the call because the SDK client lives in its context. Returns the text
  // on a hit, "gone" when the server has nothing under the id (expired or never
  // held — terminal), or undefined on a transient failure worth a later retry.
  recover?: (id: string) => Promise<string | "gone" | undefined>
  onRecovered?: (text: string) => void
  onRecoverFailed?: () => void
}) {
  const [store, setStore] = createStore({
    active: false,
    // Audio only reaches the socket once the OS route opens, which trails the
    // press by up to a second on a cold start. Words spoken before that are
    // gone, so the overlay has to distinguish arming from listening.
    listening: false,
    // A batch engine transcribes only after the mic stops, so the overlay has
    // to keep rendering while the result is still in flight.
    transcribing: false,
    // The socket dropped mid-session and the server is holding the transcript;
    // the overlay stays up saying so until the pull lands or gives up.
    recovering: false,
    // While paused the mic stays live but its frames are dropped, so the audio
    // spoken during the pause never reaches the server.
    paused: false,
    committed: "",
    interim: "",
  })

  let session: { socket: WebSocket; context: AudioContext; stream: MediaStream; target: number } | undefined
  // Read by the worklet's frame handler to drop audio while paused. A plain
  // variable rather than store state so the hot per-frame path never reads
  // through the reactive layer.
  let paused = false
  // The live analyser drives the waveform canvas directly (its own rAF reads
  // frequency data), so per-frame audio levels never churn the Solid store.
  let analyser: AnalyserNode | undefined
  // A stop() during start()'s awaits finds no session to release, so a start
  // that resumes afterward would strand a hot mic with nothing on screen. The
  // epoch lets the resumed start detect the intervening stop and release instead.
  let epoch = 0
  // Set while start() is between dialing the socket and committing a session.
  // A stop in that window has no session to release, but the socket is already
  // connected server-side; without this hook it stays open until getUserMedia
  // settles — minutes, when the user ignores the mic-permission prompt.
  let abortStart: (() => void) | undefined
  // Shared by concurrent settle() callers so the transcript is delivered once.
  let settling: Promise<string> | undefined
  // The graph a settle() is waiting on. settle() hands the session over, so
  // without this a discard arriving while the engine transcribes has nothing
  // left to close.
  let draining: { socket: WebSocket; context: AudioContext; stream: MediaStream } | undefined
  // Minted per session, sent to the server on connect, and held only in memory:
  // a reload drops it (the user is starting over), a reconnect keeps it (the
  // held transcript can still be pulled). The server tags its buffer with it.
  let id: string | undefined
  // Set on an intentional end (settle/stop) so an unexpected socket close is
  // told apart from the user finishing. Only an unexpected close recovers.
  let stopped = false

  const supported = () => !!navigator.mediaDevices?.getUserMedia

  const teardown = () => {
    epoch++
    abortStart?.()
    settling = undefined
    paused = false
    // Clear the transcript even with no live session, so a discard after the
    // mic already stopped cannot leave stale text for the next dictation.
    setStore({ active: false, listening: false, transcribing: false, paused: false, committed: "", interim: "" })
    analyser = undefined
    // Ahead of the graph check: a teardown during start()'s awaits has no
    // session to release, and leaving the claim behind paints a mic that is
    // capturing nothing as live.
    if (active === stop) setActive(undefined)
    const graph = session ?? draining
    session = undefined
    draining = undefined
    if (!graph) return
    abort(graph.socket, graph.context, graph.stream)
  }

  // Releases the microphone but leaves the socket open, since a batch engine
  // sends nothing until the audio ends. Resolves on the final transcript, the
  // socket closing, or the drain ceiling, whichever comes first.
  // Resolving transfers ownership of the transcript to the caller, so the
  // store is left empty for the next dictation. Concurrent callers (the
  // overlay's unmount and the host's own accept) share one promise, so the
  // transcript is delivered exactly once.
  const settle = () => {
    if (settling) return settling
    stopped = true
    if (!session) {
      const transcript = text()
      setStore({ transcribing: false, committed: "", interim: "" })
      return Promise.resolve(transcript)
    }
    const { socket, context, stream, target } = session
    session = undefined
    draining = { socket, context, stream }
    analyser = undefined
    paused = false
    if (active === stop) setActive(undefined)
    setStore({ active: false, listening: false, paused: false, transcribing: true })
    const closeAudio = release(socket, context, stream, target)
    settling = new Promise<string>((resolve) => {
      let done = false
      const settled = () => {
        if (done) return
        done = true
        const transcript = text()
        setStore({ transcribing: false, committed: "", interim: "" })
        settling = undefined
        draining = undefined
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

  const stop = () => {
    stopped = true
    teardown()
  }

  // Pulls the transcript the server held after an unexpected drop. Fired both
  // immediately on the drop (the socket may have died alone while the app stayed
  // online) and again when the app reconnects (a whole-app outage). The
  // server's one-shot delete makes a duplicate pull harmless: the second reads
  // nothing.
  const attemptRecover = async () => {
    if (!store.recovering || !id || !opts.recover) return
    const pending = id
    const recovered = await opts.recover(pending).catch(() => undefined)
    // A concurrent success or a new session already cleared recovery; ignore a
    // late resolve so it cannot overwrite the next dictation.
    if (!store.recovering || id !== pending) return
    // A transient failure keeps recovery armed for the reconnect trigger.
    if (recovered === undefined) return
    setStore("recovering", false)
    id = undefined
    if (recovered === "gone") return opts.onRecoverFailed?.()
    if (recovered) opts.onRecovered?.(recovered)
  }

  // Pausing commits the audio so far as its own chunk, then drops incoming
  // frames until resume. Committing on pause (not resume) means a long pause's
  // chunk is already transcribed by the time the user accepts.
  const pause = () => {
    if (!session || paused) return
    if (session.socket.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify({ type: "commit" }))
    paused = true
    setStore("paused", true)
  }

  const resume = () => {
    if (!session || !paused) return
    paused = false
    setStore("paused", false)
  }

  const text = () => [store.committed, store.interim].filter(Boolean).join(" ")

  const start = async () => {
    if (session) return
    active?.()
    setActive(stop)
    // A fresh dictation starts from an empty transcript and no leftover recovery
    // state, whatever an earlier session's exit path left behind.
    setStore({ committed: "", interim: "", recovering: false })
    stopped = false
    id = crypto.randomUUID()
    const generation = ++epoch

    // Open the mic first thing, still inside the press: it is the slow step on
    // iOS and depends on nothing the server sends, so it runs while the socket
    // handshake happens alongside it. The abort path stops it whether or not it
    // has resolved yet.
    const mic = openMic()
    // A permission denial can settle before a handler is attached (acquire() or
    // dispose()); this keeps that rejection from surfacing as unhandled without
    // consuming it for the awaiters below.
    mic.catch(() => {})

    // The handshake crosses the network (a full RTT or two on cellular) while
    // the mic opens locally, so neither waits on the other. Audio produced
    // before the socket opens queues in `pending`.
    const url = new URL(opts.url() + "/dictation/connect")
    // The server tags its audio buffer with this so an unexpected drop can hold
    // the finished transcript for the pull.
    url.searchParams.set("id", id)
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
    // Capture starts at DEFAULT_RATE and is rebuilt if the server names another,
    // so a model whose rate changed reaches every client through a reconnect.
    // A socket that closes before naming a rate fails the start rather than
    // leaving it waiting forever.
    let resolveRate: (rate: number) => void
    const wireRate = new Promise<number>((resolve, reject) => {
      resolveRate = resolve
      socket.addEventListener("close", () => reject(new Error("Dictation connection closed")), { once: true })
    })
    wireRate.catch(() => {})
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data))
      if (message.type === "rate") {
        resolveRate(message.rate)
        return
      }
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
      // An unexpected close (the user did not stop) means the server is holding
      // the finished transcript under our id. Release the mic but enter recovery
      // instead of failing, then pull immediately — the socket may have died
      // alone while the app stayed online. A whole-app outage is covered by the
      // consumer re-firing recover() on reconnect.
      if (!stopped && id && opts.recover) {
        teardown()
        setStore("recovering", true)
        void attemptRecover()
        return
      }
      // A network drop otherwise leaves the overlay rendering a live-looking
      // mic forever. Error before teardown: the host dismisses while the
      // transcript is still in the store, so the overlay's unmount settle()
      // hands the text to the host.
      opts.onError?.("Dictation connection closed")
      teardown()
    }

    // Build the capture graph in-gesture at the default rate, in parallel with
    // the mic open and the socket handshake. This is what puts AudioContext
    // creation and resume() inside the user-activation window iOS requires,
    // rather than after the server round-trip. The server's rate is reconciled
    // once it arrives, below.
    const acquiring = acquire(DEFAULT_RATE, mic)
    acquiring.catch(() => {})

    let stream: MediaStream | undefined
    let context: AudioContext | undefined
    const dispose = () => {
      // A late dispose of an abandoned start must not clear the hook a newer
      // start has installed.
      if (abortStart === dispose) abortStart = undefined
      socket.onclose = null
      socket.close()
      // The mic may still be opening when the abort lands, so stop its tracks
      // whenever they arrive rather than only the copy acquire() has handed
      // back. If getUserMedia rejects there is nothing to stop.
      if (stream) for (const track of stream.getTracks()) track.stop()
      else void mic.then((s) => s.getTracks().forEach((track) => track.stop())).catch(() => {})
      // Same for the context: acquire() may still be building it when we abort.
      if (context) context.close().catch(() => {})
      else void acquiring.then((g) => g.context.close().catch(() => {})).catch(() => {})
    }
    abortStart = dispose

    try {
      const graph = await acquiring
      // Adopt the graph into the outer refs immediately, so dispose() tears it
      // down on any early return below rather than each site cleaning up by hand.
      stream = graph.stream
      context = graph.context
      if (generation !== epoch) {
        dispose()
        return
      }
      // Honor the server's rate. It almost always matches DEFAULT_RATE, so the
      // graph built in-gesture stands; only a model-rate change forces a rebuild
      // of the CONTEXT at the rate the server named, reusing the open mic. The
      // rebuild runs after awaits, so its resume() is outside the gesture window
      // — acceptable because a rate change is rare and the user can retry, where
      // the common path keeps the in-gesture guarantee.
      const target = await wireRate
      if (generation !== epoch) {
        dispose()
        return
      }
      if (target !== DEFAULT_RATE) {
        context.close().catch(() => {})
        const rebuilt = await acquire(target, Promise.resolve(stream))
        context = rebuilt.context
        if (generation !== epoch) {
          dispose()
          return
        }
      }
      if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
        throw new Error("Dictation connection closed")
      }

      const worklet = new AudioWorkletNode(context, "dictation-capture", { processorOptions: { target } })
      // Frames arrive before the audio route opens, so signal is what proves the
      // microphone is live and the user can safely start speaking.
      let silent = true
      worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (paused) return
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

      // Waveform reads this analyser's time-domain data on its own rAF and scales
      // it to its own adapted range, so no gain node sits in front: the raw
      // capture is what it measures, and nothing downstream of the worklet sees
      // the analyser, so the model still gets the untouched signal. fftSize sets
      // the RMS window; 1024 samples is enough to average out per-sample jitter.
      analyser = context.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)

      session = { socket, context, stream, target }
      abortStart = undefined
      setStore("active", true)
    } catch (error) {
      if (session?.socket === socket) {
        session = undefined
        analyser = undefined
      }
      dispose()
      if (active === stop) setActive(undefined)
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
    recovering: () => store.recovering,
    paused: () => store.paused,
    committed: () => store.committed,
    interim: () => store.interim,
    settle,
    analyser: () => analyser,
    start,
    stop,
    pause,
    resume,
    // Re-attempts the recovery pull; the consumer calls this when the app
    // reconnects, to cover a drop that took the whole connection down.
    retryRecover: attemptRecover,
  }
}
