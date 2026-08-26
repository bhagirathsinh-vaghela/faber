import { createEffect, onCleanup, onMount } from "solid-js"

// Canvas audio-level meter for the dictation HUD, in the style of the
// ElevenLabs live-waveform: symmetric bars mirrored around a vertical center,
// grown from the voice-band slice of the analyser's frequency data, alpha
// scaled by loudness, edges faded out. When no analyser is connected yet (or
// the mic is silent) the bars breathe on a slow sine so the meter never reads
// as dead.
const BAR_WIDTH = 3
const BAR_GAP = 2
const BAR_RADIUS = 1.5
const MIN_SCALE = 0.06
const FADE = 28
// The human voice lives in the low end of the FFT bins; sampling 5%-42%
// keeps the bars responsive to speech rather than room hiss.
const BAND_START = 0.05
const BAND_END = 0.42

export function DictationWaveform(props: {
  analyser: () => AnalyserNode | undefined
  // Bars that move before audio flows read as a live mic, and the rAF driving
  // them is spent on a device that is still waiting for the capture route.
  live?: () => boolean
  color?: string
}) {
  let canvas: HTMLCanvasElement | undefined

  onMount(() => {
    if (!canvas) return
    // NOT desynchronized: that hint hands the canvas to the display controller
    // on its own layer, which Chrome on Android composites opaque — the bars
    // arrive on a black rectangle instead of over the panel. The latency it
    // trades for is worthless here anyway, since the draw loop is throttled to
    // 30fps below.
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    let raf = 0
    let phase = 0
    let width = 0
    let height = 0
    let last = 0
    let bins: Uint8Array<ArrayBuffer> | undefined
    let fade: CanvasGradient | undefined
    // ~30fps is plenty for an audio meter and halves wake-ups vs. 60fps,
    // which matters for mobile battery.
    const FRAME = 1000 / 30

    // Resolved once per resize, not per frame: getComputedStyle forces a style
    // recalc, which at 30fps is pure waste for a value that only moves with
    // the theme.
    let resolved = "#fff"
    const resize = () => {
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      // Cap DPR at 2: phones report 3, which triples per-frame fill work for
      // no visible gain on bars this small.
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      canvas.width = Math.round(rect.width * dpr)
      canvas.height = Math.round(rect.height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      width = rect.width
      height = rect.height
      fade = undefined
      resolved = getComputedStyle(canvas).color || "#fff"
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()

    const color = () => props.color ?? resolved

    const flat = () => {
      if (!width || !height) return
      ctx.clearRect(0, 0, width, height)
      const step = BAR_WIDTH + BAR_GAP
      const count = Math.max(1, Math.floor(width / step))
      const bar = Math.max(BAR_WIDTH, MIN_SCALE * height)
      ctx.fillStyle = color()
      ctx.globalAlpha = 0.35
      for (let i = 0; i < count; i++) {
        const x = i * step + (width - count * step) / 2
        ctx.beginPath()
        ctx.roundRect(x, height / 2 - bar / 2, BAR_WIDTH, bar, BAR_RADIUS)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }

    const draw = (now: number) => {
      // An idle mic has nothing to animate, so the loop stops rather than
      // burning a wake-up per frame until audio arrives.
      if (props.live && !props.live()) {
        raf = 0
        flat()
        return
      }
      raf = requestAnimationFrame(draw)
      if (now - last < FRAME || !width || !height) return
      last = now
      phase += 0.05
      ctx.clearRect(0, 0, width, height)

      const step = BAR_WIDTH + BAR_GAP
      const count = Math.max(1, Math.floor(width / step))
      const half = Math.floor(count / 2)
      const center = height / 2
      const fill = color()

      const analyser = props.analyser()
      if (analyser) {
        if (bins?.length !== analyser.frequencyBinCount) bins = new Uint8Array(analyser.frequencyBinCount)
        analyser.getByteFrequencyData(bins)
      } else bins = undefined

      for (let i = 0; i < count; i++) {
        const scale = level(i, half, bins, phase)
        const bar = Math.max(BAR_WIDTH, scale * height * 0.7)
        const x = i * step + (width - count * step) / 2
        ctx.fillStyle = fill
        ctx.globalAlpha = 0.35 + scale * 0.65
        ctx.beginPath()
        ctx.roundRect(x, center - bar / 2, BAR_WIDTH, bar, BAR_RADIUS)
        ctx.fill()
      }
      ctx.globalAlpha = 1

      if (!fade) {
        fade = ctx.createLinearGradient(0, 0, width, 0)
        const edge = Math.min(0.4, FADE / width)
        fade.addColorStop(0, "rgba(0,0,0,1)")
        fade.addColorStop(edge, "rgba(0,0,0,0)")
        fade.addColorStop(1 - edge, "rgba(0,0,0,0)")
        fade.addColorStop(1, "rgba(0,0,0,1)")
      }
      ctx.globalCompositeOperation = "destination-out"
      ctx.fillStyle = fade
      ctx.fillRect(0, 0, width, height)
      ctx.globalCompositeOperation = "source-over"
    }
    raf = requestAnimationFrame(draw)

    createEffect(() => {
      if (props.live && !props.live()) return
      if (raf) return
      raf = requestAnimationFrame(draw)
    })

    onCleanup(() => {
      cancelAnimationFrame(raf)
      observer.disconnect()
    })
  })

  return <canvas ref={canvas} class="block size-full text-icon-primary" aria-hidden="true" />
}

// Bar height for column i: the frequency reading when the mic is live and
// loud, otherwise a center-weighted breathing wave so silence still moves.
function level(i: number, half: number, bins: Uint8Array | undefined, phase: number) {
  const position = (i - half) / (half || 1)
  const breathe =
    (0.14 + Math.sin(phase + position * 3) * 0.08 + Math.cos(phase * 1.6 - position * 2) * 0.05) *
    (1 - Math.abs(position) * 0.4)
  if (!bins) return Math.max(MIN_SCALE, breathe)
  const band = bins.subarray(Math.floor(bins.length * BAND_START), Math.floor(bins.length * BAND_END))
  const mirrored = i < half ? half - 1 - i : i - half
  const value = (band[Math.floor((mirrored / (half || 1)) * band.length)] ?? 0) / 255
  return Math.max(MIN_SCALE, breathe * 0.5, value)
}
