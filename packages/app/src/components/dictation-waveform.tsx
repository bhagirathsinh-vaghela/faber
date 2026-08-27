import { createEffect, onCleanup, onMount } from "solid-js"

// Siri-style waveform of layered sine waves; intentionally not themed.
const WAVES = [
  { color: "15, 82, 169", freq: 1.5, amp: 1.0, opacity: 0.7 },
  { color: "173, 57, 76", freq: 2.3, amp: 0.7, opacity: 0.6 },
  { color: "48, 220, 155", freq: 3.0, amp: 0.5, opacity: 0.5 },
]
// Averaging this low-end FFT slice stands in for a voice-activity level.
const BAND_START = 0.05
const BAND_END = 0.42
// Idle breathing so a live-but-silent mic still ripples instead of flatlining.
const IDLE_LEVEL = 0.08
const SENSITIVITY = 2.4

export function DictationWaveform(props: {
  analyser: () => AnalyserNode | undefined
  // Bars that move before audio flows read as a live mic, and the rAF driving
  // them is spent on a device that is still waiting for the capture route.
  live?: () => boolean
  // Dims and desaturates while paused: the mic is live but not accumulating.
  paused?: () => boolean
}) {
  let canvas: HTMLCanvasElement | undefined

  onMount(() => {
    if (!canvas) return
    // NOT desynchronized: that hint hands the canvas to the display controller
    // on its own layer, which Chrome on Android composites opaque — the wave
    // arrives on a black rectangle instead of over the panel.
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    let raf = 0
    let width = 0
    let height = 0
    let last = 0
    let displayLevel = 0
    let bins: Uint8Array<ArrayBuffer> | undefined
    const FRAME = 1000 / 60
    const STEP = 1

    const resize = () => {
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      canvas.width = Math.round(rect.width * dpr)
      canvas.height = Math.round(rect.height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      width = rect.width
      height = rect.height
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()

    const target = () => {
      const analyser = props.analyser()
      if (!analyser) return IDLE_LEVEL
      if (bins?.length !== analyser.frequencyBinCount) bins = new Uint8Array(analyser.frequencyBinCount)
      analyser.getByteFrequencyData(bins)
      const from = Math.floor(bins.length * BAND_START)
      const to = Math.floor(bins.length * BAND_END)
      let sum = 0
      for (let i = from; i < to; i++) sum += bins[i]!
      const avg = sum / (to - from) / 255
      return Math.max(IDLE_LEVEL, Math.min(1, avg * SENSITIVITY))
    }

    const support = () => {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.28)"
      ctx.lineWidth = 0.5
      ctx.beginPath()
      ctx.moveTo(0, height / 2)
      ctx.lineTo(width, height / 2)
      ctx.stroke()
    }

    const draw = (now: number) => {
      if (props.live && !props.live()) {
        raf = 0
        ctx.clearRect(0, 0, width, height)
        support()
        return
      }
      raf = requestAnimationFrame(draw)
      if (now - last < FRAME || !width || !height) return
      last = now

      // Snap within a hair of the target so a settled level stops churning
      // sub-pixel redraws; ease otherwise.
      const goal = target()
      if (Math.abs(goal - displayLevel) < 0.001) displayLevel = goal
      else displayLevel += (goal - displayLevel) * 0.55

      const paused = props.paused?.() ?? false
      ctx.clearRect(0, 0, width, height)
      ctx.globalAlpha = paused ? 0.4 : 1
      support()

      const amp = displayLevel
      if (amp > 0.001) {
        const mid = height / 2
        for (const wave of WAVES) {
          const fill = paused ? `rgba(255, 255, 255, ${wave.opacity * 0.6})` : `rgba(${wave.color}, ${wave.opacity})`
          ctx.fillStyle = fill
          for (const sign of [1, -1]) {
            ctx.beginPath()
            for (let x = 0; x <= width; x += STEP) {
              const norm = x / width
              const envelope = Math.pow(Math.sin(norm * Math.PI), 1.5)
              const waveY = Math.sin(norm * wave.freq * Math.PI * 2)
              const y = mid + sign * amp * wave.amp * (height / 2) * envelope * waveY
              if (x === 0) ctx.moveTo(x, y)
              else ctx.lineTo(x, y)
            }
            ctx.closePath()
            ctx.fill()
          }
        }
      }
      ctx.globalAlpha = 1
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

  return <canvas ref={canvas} class="block size-full" aria-hidden="true" />
}
