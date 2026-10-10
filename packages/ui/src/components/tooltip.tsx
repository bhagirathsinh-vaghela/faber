import { Tooltip as KobalteTooltip } from "@kobalte/core/tooltip"
import { children, createSignal, Match, onCleanup, onMount, splitProps, Switch, type JSX } from "solid-js"
import type { ComponentProps } from "solid-js"

export interface TooltipProps extends ComponentProps<typeof KobalteTooltip> {
  value: JSX.Element
  class?: string
  contentClass?: string
  contentStyle?: JSX.CSSProperties
  inactive?: boolean
  forceOpen?: boolean
}

export interface TooltipKeybindProps extends Omit<TooltipProps, "value"> {
  title: string
  keybind: string
}

export function TooltipKeybind(props: TooltipKeybindProps) {
  const [local, others] = splitProps(props, ["title", "keybind"])
  return (
    <Tooltip
      {...others}
      value={
        <div data-slot="tooltip-keybind">
          <span>{local.title}</span>
          <span data-slot="tooltip-keybind-key">{local.keybind}</span>
        </div>
      }
    />
  )
}

export function Tooltip(props: TooltipProps) {
  const [open, setOpen] = createSignal(false)
  // Long-press "pin": on touch we open the tooltip and keep it open after the
  // finger lifts (Kobalte would otherwise close it on pointer-up). Pinned stays
  // true until the next touch outside the trigger. Forced into the open state
  // below so Kobalte's own release-close can't override it.
  const [pinned, setPinned] = createSignal(false)
  const [local, others] = splitProps(props, [
    "children",
    "class",
    "contentClass",
    "contentStyle",
    "inactive",
    "forceOpen",
  ])

  const c = children(() => local.children)

  // Touch long-press support: mobile browsers have no hover, so a tooltip would
  // otherwise never appear. We open it after a ~1500ms press (a chosen value)
  // and close it when the finger lifts (endPress) or on a touch elsewhere. The
  // timer is armed only on touchstart, so desktop hover is untouched.
  // touchmove/touchend/touchcancel before the threshold cancel it (a scroll or
  // quick tap is not a long-press).
  //
  // We deliberately DO NOT swallow the tap's click. Matching native icon-button
  // behavior, a tap always activates the button on the first try; long-press
  // only reveals the tooltip. A held tap that crosses the threshold
  // both shows the tooltip and (on release) fires the button — the accepted
  // trade for never eating a first tap.
  let pressTimer: ReturnType<typeof setTimeout> | undefined
  const cancelPress = () => {
    if (pressTimer === undefined) return
    clearTimeout(pressTimer)
    pressTimer = undefined
  }
  const startPress = () => {
    cancelPress()
    pressTimer = setTimeout(() => {
      setPinned(true)
      setOpen(true)
    }, 1500)
  }
  // On release (lift, slide-off, or cancel): drop the pending timer AND close an
  // already-shown tooltip, so the tooltip lives only while the finger is down.
  // Without this, holding to show then lifting (or sliding the finger off the
  // button) would leave the tooltip stuck open until a tap
  // elsewhere. Sliding off before touchend fires no synthesized click, so the
  // button correctly does not activate — only the tooltip needs closing.
  const endPress = () => {
    cancelPress()
    setPinned(false)
    setOpen(false)
  }

  onMount(() => {
    // Close an open (long-pressed) tooltip on the next touch elsewhere.
    const closeOnOutside = (e: TouchEvent) => {
      const els = c()
      const nodes = Array.isArray(els) ? els : [els]
      const inside = nodes.some((n) => n instanceof HTMLElement && n.contains(e.target as Node))
      if (!inside) {
        setPinned(false)
        setOpen(false)
      }
    }
    document.addEventListener("touchstart", closeOnOutside, { passive: true })

    const childElements = c()
    const arm = (el: HTMLElement) => {
      el.addEventListener("focusin", () => setOpen(true))
      el.addEventListener("focusout", () => setOpen(false))
      el.addEventListener("touchstart", startPress, { passive: true })
      el.addEventListener("touchend", endPress, { passive: true })
      // A slide before the tooltip opens is a scroll, not a long-press — cancel
      // the pending timer but don't force-close (it isn't open yet).
      el.addEventListener("touchmove", cancelPress, { passive: true })
      el.addEventListener("touchcancel", endPress, { passive: true })
    }
    if (childElements instanceof HTMLElement) arm(childElements)
    else if (Array.isArray(childElements))
      for (const child of childElements) if (child instanceof HTMLElement) arm(child)

    onCleanup(() => document.removeEventListener("touchstart", closeOnOutside))
  })

  return (
    <Switch>
      <Match when={local.inactive}>{local.children}</Match>
      <Match when={true}>
        <KobalteTooltip
          openDelay={0}
          gutter={4}
          {...others}
          open={local.forceOpen || pinned() || open()}
          onOpenChange={setOpen}
        >
          <KobalteTooltip.Trigger
            as={"div"}
            data-component="tooltip-trigger"
            class={local.class}
            style={{ "-webkit-touch-callout": "none", "-webkit-user-select": "none", "user-select": "none" }}
          >
            {c()}
          </KobalteTooltip.Trigger>
          <KobalteTooltip.Portal>
            <KobalteTooltip.Content
              data-component="tooltip"
              data-placement={props.placement}
              data-force-open={local.forceOpen}
              class={local.contentClass}
              style={local.contentStyle}
            >
              {others.value}
              {/* <KobalteTooltip.Arrow data-slot="tooltip-arrow" /> */}
            </KobalteTooltip.Content>
          </KobalteTooltip.Portal>
        </KobalteTooltip>
      </Match>
    </Switch>
  )
}
