import { createEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { claimOverlay } from "@/utils/overlay"

// The floating HUD shared by dictation and speech playback: a dim scrim, a
// bottom-anchored accent-bordered panel, and the document-level key/pointer
// handling both need. Only the contents differ, so the shell lives here rather
// than in each — a change to the scrim or the anchoring reaches both.
export function OverlayPanel(props: {
  accent?: string
  // A pointer landing outside the panel. What that resolves to is the caller's
  // (accept a transcript, stop a reading).
  onDismiss: () => void
  // Escape, whose meaning is cancel: discard whatever the panel holds.
  onEscape?: () => void
  onKey?: (event: KeyboardEvent) => void
  // Pointer targets the panel must not treat as outside, for a toggle that
  // handles its own dismissal.
  ignore?: string
  // Both colors are handed down so a caller styling its own controls resolves
  // the accent fallback here rather than restating it.
  children: (color: { accent: () => string; text: () => string }) => JSX.Element
}) {
  let panelRef: HTMLDivElement | undefined

  // Claimed by the shell rather than by each caller, so a new overlay inherits
  // the precedence instead of restating it.
  claimOverlay()

  const handleKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      ;(props.onEscape ?? props.onDismiss)()
      return
    }
    props.onKey?.(event)
  }

  const handlePointer = (event: PointerEvent) => {
    const target = event.target as HTMLElement | null
    if (!target) return
    if (panelRef?.contains(target)) return
    if (props.ignore && target.closest(props.ignore)) return
    props.onDismiss()
  }

  // The scrim swallows the wheel event that would have reached the app, so the
  // scroll it prevented is re-dispatched to whatever sits under the cursor.
  const forwardWheel = (event: WheelEvent) => {
    const under = document
      .elementsFromPoint(event.clientX, event.clientY)
      .find((el) => el !== event.currentTarget && el.scrollHeight > el.clientHeight)
    under?.scrollBy({ top: event.deltaY, left: event.deltaX })
  }

  onMount(() => {
    document.addEventListener("keydown", handleKey, true)
    document.addEventListener("pointerdown", handlePointer, true)
  })
  onCleanup(() => {
    document.removeEventListener("keydown", handleKey, true)
    document.removeEventListener("pointerdown", handlePointer, true)
  })

  const accent = () => props.accent ?? "var(--icon-interactive-base)"

  // The probe resolves the accent, which may be a CSS variable, to a measurable
  // color: a label takes a deep shade of the accent itself rather than flat
  // black or white, so a button stays one hue at any accent luminance.
  let probe: HTMLSpanElement | undefined
  const [accentText, setAccentText] = createSignal(`color-mix(in srgb, ${accent()} 30%, white)`)
  createEffect(() => {
    if (!probe) return
    const resolved = getComputedStyle(probe).backgroundColor
    const match = resolved.match(/\d+(\.\d+)?/g)
    if (!match) return
    const [r, g, b] = match.map(Number)
    const luminance = (0.299 * r! + 0.587 * g! + 0.114 * b!) / 255
    setAccentText(
      luminance > 0.5 ? `color-mix(in srgb, ${accent()} 25%, black)` : `color-mix(in srgb, ${accent()} 25%, white)`,
    )
  })

  return (
    <Portal>
      <span
        ref={probe}
        aria-hidden="true"
        style={{ position: "absolute", width: 0, height: 0, "background-color": accent() }}
      />
      <div
        class="fixed inset-0 z-[9998] overscroll-contain"
        style={{ background: "rgba(0, 0, 0, 0.7)" }}
        onWheel={forwardWheel}
      />
      {/* --composer-top is published by PromptInput as the gap from the viewport
          bottom to the top of the composer, and is absent when no composer is
          rendered (reader mode), where the fallback puts the panel a fifth of
          the way up. dvh, not vh: the mobile bar collapsing must not shift it. */}
      <div class="fixed inset-x-0 bottom-[calc(var(--composer-top,20dvh)+16px)] z-[9999] flex justify-center pointer-events-none px-4">
        <div
          ref={panelRef}
          class="pointer-events-auto w-full max-w-md flex flex-col gap-2 rounded-[1.75rem] border-[4.5px] bg-surface-raised-stronger-non-alpha p-2 transform-gpu isolate"
          style={{
            "border-color": accent(),
            "box-shadow": `0 0 0 1px color-mix(in srgb, ${accent()} 35%, transparent), 0 0 24px 4px color-mix(in srgb, ${accent()} 30%, transparent), 0 8px 24px rgba(0,0,0,0.4)`,
          }}
        >
          {props.children({ accent, text: accentText })}
        </div>
      </div>
    </Portal>
  )
}
