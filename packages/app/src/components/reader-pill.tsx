import { For, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { Icon } from "@opencode-ai/ui/icon"
import { MicIcon } from "@/components/mic-icon"
import { useLayout } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { dictationRunning, dictationTarget } from "@/utils/dictation"
import { createCoarsePointer, TOUCH_SLOP } from "@/utils/mobile"

// Sized for a fingertip on every device: the pill floats over content, so it
// gets the enhanced touch target even under a mouse, and a touch pointer a
// little more.
const MARGIN = 16
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

// The pill computes its own geometry (drag bounds, the anchor corner), so it
// reads the shared control size as a number rather than inheriting it in CSS.
const cssPx = (name: string, fallback: number) =>
  parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || fallback

// Bigger than a dock button: it floats over content with no neighbours to
// separate it from.
const PILL_SCALE = 1.45

// Orbs above the bottom one are separated by this gap, and the whole stack is
// clamped as one so a sibling appearing on top can't push it off screen.
const STACK_GAP = 10

// The glyph fills the same fraction of this control that an icon fills of any
// other, read from the ratio the stylesheet already applies.
const iconRatio = () => cssPx("--control-icon", 20) / cssPx("--control-height", 36)

// The floating reader controls. The orb set is mode-dependent: a lone book orb
// enters sticky reader from interactive; in a reader session the mic floats,
// joined by an exit orb once a non-sticky composer is up. `anchor` is the box
// the stack hovers above; a page without one passes nothing and gets the corner.
export function ReaderPill(props: { anchor?: () => { right: number; top: number } | null }) {
  const layout = useLayout()
  const language = useLanguage()
  const coarse = createCoarsePointer()
  // Tracks --control-height, so the one number that sizes every button sizes
  // this too. coarse() is read so the value recomputes when the pointer changes.
  const size = () => {
    void coarse()
    return Math.round(cssPx("--control-height", 36) * PILL_SCALE)
  }

  // Bottom-to-top. The book orb is the deliberate sticky toggle, shown whenever
  // no mic is present (interactive). In a
  // reader session the mic replaces it, and the exit orb joins on top once the
  // non-sticky composer is up.
  // Every orb is a transparent ghost ring; the glyph carries its own backing via
  // an interior filled with the disc color (--orb-glyph-fill), so it floats over
  // content without a solid disc covering it.
  type Orb = { label: string; press: () => void; icon: JSX.Element; dictation?: boolean }
  const orbs = createMemo<Orb[]>(() => {
    if (!layout.reader.opened()) {
      return [
        {
          label: language.t("reader.enter"),
          press: () => layout.reader.toggle(),
          icon: (
            <Icon name="book-open-filled" class="size-full" style={{ color: "var(--icon-strong-base)" }} />
          ),
        },
      ]
    }
    const list: Orb[] = [
      {
        label: language.t("reader.dictate"),
        press: () => dictationTarget()?.toggle(),
        dictation: true,
        icon: <MicIcon class="size-full" running={dictationRunning()} targeted filled />,
      },
    ]
    if (layout.reader.revealed()) {
      // On top, so pressing it never disturbs the mic beneath.
      list.push({
        label: language.t("reader.exit"),
        press: () => layout.reader.exitToInteractive(),
        icon: <Icon name="book-check-filled" class="size-full" style={{ color: "var(--icon-strong-base)" }} />,
      })
    }
    return list
  })

  const stack = () => orbs().length * size() + (orbs().length - 1) * STACK_GAP
  // How far the stack rises above its bottom orb.
  const above = () => stack() - size()

  // x/y address the BOTTOM orb, and the rest hang off it upward. That orb is the
  // one constant across modes and where a parked position was aimed, so it must
  // not move when a sibling appears above it. The upper bound stays the stack's,
  // since a legal bottom orb can still push a sibling off the top.
  const clamp = (x: number, y: number) => ({
    x: Math.max(MARGIN + inset("--sal"), Math.min(x, window.innerWidth - size() - MARGIN - inset("--sar"))),
    y: Math.max(MARGIN + inset("--sat") + above(), Math.min(y, window.innerHeight - size() - MARGIN - inset("--sab"))),
  })

  const [drag, setDrag] = createSignal<{ x: number; y: number } | null>(null)
  const [pos, setPos] = createSignal<{ x: number; y: number } | null>(null)
  // A press reshapes the dock under the pointer, which would otherwise slide the
  // pill away mid-press and land the release elsewhere.
  const [pressing, setPressing] = createSignal(false)

  const anchored = createMemo(() => {
    const rect = props.anchor?.()
    if (!rect) return null
    return {
      x: Math.min(rect.right - size() + NUDGE, window.innerWidth - size() - MARGIN),
      y: rect.top - size() - GAP,
    }
  })

  const [resting, setResting] = createSignal<{ x: number; y: number } | null>(null)
  createEffect(() => {
    const live = anchored()
    if (!live || pressing()) return
    setResting(live)
  })

  // A narrower window changes what an x MEANS, so a parked pill keeps its gap
  // to the NEARER horizontal edge rather than its absolute value. Holding x
  // across a narrowing pulls a right-parked pill toward the middle, and the
  // window widening back leaves it there.
  //
  // Measured against the width the pill was last placed in, since by the time a
  // resize fires window.innerWidth is already the new one.
  //
  // A shorter window still means the same y, so height needs no equivalent: the
  // soft keyboard borrows that room for as long as it is up and then returns it.
  let placedIn = window.innerWidth
  const remap = () => {
    const was = placedIn
    placedIn = window.innerWidth
    setPos((p) => {
      if (!p) return p
      const right = was - (p.x + size())
      if (right > p.x) return p
      return { x: window.innerWidth - size() - right, y: p.y }
    })
  }
  onMount(() => {
    window.addEventListener("resize", remap)
    onCleanup(() => window.removeEventListener("resize", remap))
  })

  // Anchor priority: a live drag wins, then a parked position, then the live
  // anchor, then the last one the anchor offered. Null until the first
  // measurement, or with no anchor at all.
  //
  // The clamp applies to what is DRAWN, while the position a drag stored stays
  // as the finger left it. A pill parked in room the soft keyboard then takes
  // is drawn above the keyboard and returns to its own spot when the room
  // comes back.
  const coords = createMemo(() => {
    const at = drag() ?? pos() ?? (pressing() ? resting() : anchored()) ?? resting()
    return at && clamp(at.x, at.y)
  })

  // Pointer events TRACK the drag; they never toggle. The toggle is the click,
  // so the pill activates like every other control (and stays reachable by
  // keyboard and screen reader). A drag past the threshold suppresses that
  // click, which is what separates "moved the pill" from "tapped the pill".
  let dragged = false
  function start(e: PointerEvent) {
    setPressing(true)
    const release = () => {
      setPressing(false)
      document.removeEventListener("pointerup", release)
      document.removeEventListener("pointercancel", release)
    }
    document.addEventListener("pointerup", release)
    document.addEventListener("pointercancel", release)

    const pill = e.currentTarget as HTMLElement
    const startX = e.clientX
    const startY = e.clientY
    dragged = false
    const box = (pill.parentElement ?? pill).getBoundingClientRect()
    const grabX = e.clientX - box.left
    const grabY = e.clientY - (box.bottom - size())

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return
      if (!dragged && Math.hypot(ev.clientX - startX, ev.clientY - startY) < TOUCH_SLOP) return
      dragged = true
      setDrag(clamp(ev.clientX - grabX, ev.clientY - grabY))
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

  const glyph = () => Math.round(size() * iconRatio())

  return (
    <Portal>
      <div
        data-reader-cluster
        class="fixed z-[100] flex flex-col items-center justify-end pointer-events-none"
        style={{
          // Positioned by its foot, so an orb appearing above the bottom one
          // grows the stack upward and leaves that orb where it was.
          ...(coords()
            ? { left: `${coords()!.x}px`, top: `${coords()!.y - above()}px` }
            : {
                right: `calc(${MARGIN}px + env(safe-area-inset-right))`,
                bottom: `calc(${MARGIN}px + env(safe-area-inset-bottom))`,
              }),
          width: `${size()}px`,
          gap: `${STACK_GAP}px`,
        }}
      >
        <For each={orbs()}>
          {(orb) => (
            <button
              type="button"
              onPointerDown={start}
              onClick={() => {
                if (dragged) {
                  dragged = false
                  return
                }
                orb.press()
              }}
              aria-label={orb.label}
              data-dictation-toggle={orb.dictation ? "" : undefined}
              class="pointer-events-auto flex items-center justify-center rounded-full border touch-none select-none cursor-grab active:cursor-grabbing border-border-base text-icon-strong-base glass"
              style={{ width: `${size()}px`, height: `${size()}px` }}
            >
              <span
                class="flex items-center justify-center rounded-full"
                // The glyph interior fills with the disc color, so it reads over
                // content without a solid orb behind it.
                style={{
                  width: `${glyph()}px`,
                  height: `${glyph()}px`,
                  "--orb-glyph-fill": "var(--surface-raised-base)",
                }}
              >
                {orb.icon}
              </span>
            </button>
          )}
        </For>
      </div>
    </Portal>
  )
}
