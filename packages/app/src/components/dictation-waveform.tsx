import { createEffect, onCleanup, onMount } from "solid-js"

// Siri-style waveform of layered sine waves; intentionally not themed.
const WAVES = [
  { color: "15, 82, 169", freq: 1.5, amp: 1.0, opacity: 0.7 },
  { color: "173, 57, 76", freq: 2.3, amp: 0.7, opacity: 0.6 },
  { color: "48, 220, 155", freq: 3.0, amp: 0.5, opacity: 0.5 },
]
// Idle breathing so a live-but-silent mic still ripples instead of flatlining.
const IDLE_LEVEL = 0.08
// The floor tracks the quietest recent level and is subtracted before expansion,
// so auto-gain raising the ambient noise up does not beach the bars at mid-level.
// It falls fast toward a new quiet (catches a room going silent) and rises slowly
// (a word does not drag the floor up with it).
const FLOOR_FALL = 0.05
const FLOOR_RISE = 0.002
// The peak tracks the loudest recent level so speech normalizes to near-full
// height regardless of absolute loudness. It rises instantly to a new peak and
// decays slowly, so the scale does not collapse between words.
const PEAK_DECAY = 0.0015
const PEAK_FLOOR = 0.02
// Below 1 expands the quiet end: normalized loudness is pushed up so present-but-
// soft speech still drives the bars, the "snap" a raw linear level lacks.
const EXPANSION = 0.6
// Asymmetric smoothing: the level jumps toward a louder target (attack) and eases
// down from it (release), which reads as lively rather than laggy.
const ATTACK = 0.6
const RELEASE = 0.15

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
    let samples: Float32Array<ArrayBuffer> | undefined
    // Running quiet floor and loud peak, adapted per frame so the level is scaled
    // to the recent dynamic range rather than to absolute loudness (which auto-gain
    // keeps shifting). The floor seeds at silence: real mic RMS sits well under 1,
    // so a high seed would stay above the signal for seconds and beach the bars.
    let floor = 0
    let peak = PEAK_FLOOR
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
      if (samples?.length !== analyser.fftSize) samples = new Float32Array(analyser.fftSize)
      // Time-domain RMS tracks perceived loudness; FFT magnitude does not, which
      // is why a frequency read looks flat once auto-gain compresses the signal.
      analyser.getFloatTimeDomainData(samples)
      let sum = 0
      for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!
      const rms = Math.sqrt(sum / samples.length)

      // Adapt the floor toward the current level: fall fast to a new quiet, rise
      // slowly so a word cannot drag it up. Adapt the peak the other way: jump to
      // a new loud, decay slowly so the scale holds between words.
      floor += (rms - floor) * (rms < floor ? FLOOR_FALL : FLOOR_RISE)
      peak = rms > peak ? rms : Math.max(PEAK_FLOOR, peak - (peak - PEAK_FLOOR) * PEAK_DECAY)

      // Normalize the above-floor loudness to the adapted range, then expand the
      // quiet end so soft speech still drives the bars.
      const span = peak - floor
      const norm = span > 0.0001 ? (rms - floor) / span : 0
      const level = Math.pow(Math.max(0, Math.min(1, norm)), EXPANSION)
      return Math.max(IDLE_LEVEL, level)
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
      // sub-pixel redraws; otherwise ease asymmetrically: jump toward a louder
      // goal (attack) and fall away from it slowly (release), which reads lively.
      const goal = target()
      if (Math.abs(goal - displayLevel) < 0.001) displayLevel = goal
      else displayLevel += (goal - displayLevel) * (goal > displayLevel ? ATTACK : RELEASE)

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
