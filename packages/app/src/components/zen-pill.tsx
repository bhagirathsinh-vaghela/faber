import { createMemo, createSignal, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useLayout } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { createCoarsePointer, useShell } from "@/utils/mobile"

// Sized for a fingertip on every device: the pill floats over content, so it
// gets the enhanced touch target even under a mouse, and a touch pointer a
// little more.
const MARGIN = 16
// Matches the platform touch slop (Android ~8dp, iOS ~10pt). Below it a thumb's
// normal wander during a tap reads as a drag, and the tap is silently dropped.
const DRAG_THRESHOLD = 10
// Gap between the pill and the anchor's top edge. Kept large enough that the
// pill clears a button's tap zone at the anchor's right edge, so a tap on the
// pill never lands on that button (and vice versa).
const GAP = 24
// Nudge the pill's right edge past the anchor's into the gutter, so it sits at
// the true screen corner rather than leaving a gap.
const NUDGE = 12

// Read a safe-area inset (exposed as a CSS var in index.css) as a number, so a
// dragged pill can't be parked under the status bar / home indicator. 0 in a
// normal browser.
const inset = (name: "--sat" | "--sar" | "--sab" | "--sal") =>
  parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0

// The one zen control. `anchor` is the box it hovers above; a page without one
// (a document rather than a transcript) passes nothing and gets the corner.
export function ZenPill(props: { anchor?: () => { right: number; top: number } | null }) {
  const layout = useLayout()
  const language = useLanguage()
  const wide = useShell().wide
  const coarse = createCoarsePointer()
  const size = () => (coarse() ? 56 : 52)

  const clamp = (x: number, y: number) => ({
    x: Math.max(MARGIN + inset("--sal"), Math.min(x, window.innerWidth - size() - MARGIN - inset("--sar"))),
    y: Math.max(MARGIN + inset("--sat"), Math.min(y, window.innerHeight - size() - MARGIN - inset("--sab"))),
  })

  const [drag, setDrag] = createSignal<{ x: number; y: number } | null>(null)
  const [pos, setPos] = createSignal<{ x: number; y: number } | null>(null)

  // Anchor priority: a mobile drag override wins; otherwise pin to the anchor's
  // top-right corner. Null until the first measurement lands, or with no anchor.
  const coords = createMemo(() => {
    const dragged = drag() ?? pos()
    if (dragged) return dragged
    const rect = props.anchor?.()
    if (!rect) return null
    return {
      x: Math.min(rect.right - size() + NUDGE, window.innerWidth - size() - MARGIN),
      y: rect.top - size() - GAP,
    }
  })

  // Pointer events TRACK the drag; they never toggle. The toggle is the click,
  // so the pill activates like every other control (and stays reachable by
  // keyboard and screen reader). A drag past the threshold suppresses that
  // click, which is what separates "moved the pill" from "tapped the pill".
  let dragged = false
  function start(e: PointerEvent) {
    if (wide()) return
    const pill = e.currentTarget as HTMLElement
    const startX = e.clientX
    const startY = e.clientY
    dragged = false

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return
      if (!dragged && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return
      dragged = true
      setDrag(clamp(ev.clientX - size() / 2, ev.clientY - size() / 2))
    }
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return
      document.removeEventListener("pointermove", move)
      document.removeEventListener("pointerup", end)
      document.removeEventListener("pointercancel", end)
      const final = drag()
      setDrag(null)
      if (final) setPos(final)
      // A canceled pointer delivers no click, so the suppression flag would
      // outlive the gesture and swallow the next genuine tap.
      if (ev.type === "pointercancel") dragged = false
    }
    document.addEventListener("pointermove", move)
    document.addEventListener("pointerup", end)
    // The browser cancels the stream when it claims the gesture for a scroll;
    // without this the move listener keeps steering the pill off any later touch.
    document.addEventListener("pointercancel", end)

    // Throws on an inactive pointer, which must not strand the drag.
    if (e.isTrusted) pill.setPointerCapture(e.pointerId)
  }

  return (
    <Portal>
      <button
        type="button"
        onPointerDown={start}
        onClick={() => {
          // A drag that ended elsewhere still emits a click here; only a tap
          // that stayed put should toggle.
          if (dragged) {
            dragged = false
            return
          }
          layout.zen.toggle()
        }}
        aria-label={layout.zen.opened() ? language.t("zen.exit") : language.t("zen.enter")}
        // wide:, not panel-wide:: the pill portals to <body>, where no ancestor
        // declares a container, so a container variant never matches and the
        // class silently does nothing.
        class="fixed z-[100] flex items-center justify-center rounded-full shadow-md border border-border-weak-base bg-surface-raised-base text-icon-base touch-none select-none cursor-grab active:cursor-grabbing wide:cursor-pointer wide:active:cursor-pointer hover:bg-surface-raised-base-hover"
        classList={{ "transition-none": drag() !== null }}
        style={{
          ...(coords()
            ? { left: `${coords()!.x}px`, top: `${coords()!.y}px` }
            : {
                right: `calc(${MARGIN}px + env(safe-area-inset-right))`,
                bottom: `calc(${MARGIN}px + env(safe-area-inset-bottom))`,
              }),
          width: `${size()}px`,
          height: `${size()}px`,
        }}
      >
        <span class="text-xl leading-none select-none" aria-hidden="true">
          {layout.zen.opened() ? "🌐" : "🧘"}
        </span>
      </button>
    </Portal>
  )
}
