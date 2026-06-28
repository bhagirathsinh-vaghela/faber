import { type JSX, Show, splitProps } from "solid-js"

// Metric chips. A ChipGroup is the rounded-border container; each
// Chip inside is a segment (icon + value) carrying its own per-metric color.
// Segments in a group are joined by straight vertical dividers; only the group
// has rounded corners. A group with one segment is just a single rounded chip
// (e.g. the context gauge chip). This restores the pre-chip
// grouping (cache group, session group) that flat standalone chips lost.
//
// Token-driven (no hardcoded color): group surface from --color-surface-inset-base,
// border from --color-border-weak-base. A segment's `accent` token colors BOTH
// its icon and value (they match). The gauge `fill` is a separate, value-driven
// background and is independent of the accent.

export type ChipProps = {
  // Leading slot — typically the metric icon.
  icon?: JSX.Element
  // Main content — label + value. Optional: an icon-only segment (e.g. the Σ
  // cluster marker) omits it.
  children?: JSX.Element
  // Raw theme token name (the runtime CSS var, NOT the --color- Tailwind alias)
  // that colors BOTH the icon and the value, so they match. e.g. "usage-cached"
  // → var(--usage-cached). Raw --<token> because Tailwind v4 tree-shakes the
  // --color-* aliases when only referenced from inline styles; the theme loader
  // always injects the raw var on :root. Omit for the neutral text-strong color.
  accent?: string
  // When set, the chip is interactive (renders a <button>).
  onClick?: (e: MouseEvent) => void
  // Fraction 0..1 for "value out of a max" metrics (e.g. context). The
  // segment background fills left-to-right to the fraction (the proven
  // Copilot/LibreChat gauge), independent of `accent`. `fillColor` tints the
  // fill; the rest is the inset track.
  fill?: number
  fillColor?: string
  class?: string
  title?: string
}

const halo = "0 1px 3px rgba(0,0,0,0.85), 0 0 2px rgba(0,0,0,0.7)"
const seg =
  "inline-flex items-center gap-1 px-1.5 py-0.5 text-[12px] leading-tight " +
  "[font-variant-numeric:tabular-nums] whitespace-nowrap"

// A single metric segment. Lives inside a ChipGroup. Carries its own accent
// color (icon + value) and optional gauge fill. No border/radius of its own —
// the group owns those; dividers between segments are drawn by the group.
export function Chip(props: ChipProps) {
  const [local, rest] = splitProps(props, [
    "icon",
    "children",
    "accent",
    "onClick",
    "fill",
    "fillColor",
    "class",
    "title",
  ])

  const tone = () => (local.accent ? `var(--${local.accent})` : "var(--color-text-strong)")

  const gaugeBg = () => {
    if (local.fill === undefined) return undefined
    const pct = Math.max(0, Math.min(1, local.fill)) * 100
    const tint = local.fillColor ? `var(--${local.fillColor})` : "var(--color-text-base)"
    return `linear-gradient(to right, color-mix(in srgb, ${tint} 28%, transparent) ${pct}%, transparent ${pct}%)`
  }

  const content = (
    <span class="inline-flex items-center gap-1" style={{ color: tone() }}>
      <Show when={local.icon}>
        <span
          class="inline-flex shrink-0 items-center [&_[data-component=icon]]:!text-current"
          data-slot="chip-icon"
          style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.85))" }}
        >
          {local.icon}
        </span>
      </Show>
      <Show when={local.children !== undefined}>
        <span class="font-extrabold" data-slot="chip-content" style={{ "text-shadow": halo }}>
          {local.children}
        </span>
      </Show>
    </span>
  )

  const cls = `${seg} relative overflow-hidden ${local.class ?? ""}`

  return (
    <Show
      when={local.onClick}
      fallback={
        <span data-slot="chip" title={local.title} class={cls} style={{ "background-image": gaugeBg() }} {...rest}>
          {content}
        </span>
      }
    >
      <button
        type="button"
        data-slot="chip"
        data-interactive="true"
        title={local.title}
        onClick={local.onClick}
        class={`${cls} cursor-pointer`}
        style={{ "background-image": gaugeBg() }}
        {...rest}
      >
        {content}
      </button>
    </Show>
  )
}

// The rounded container. Wraps one or more Chip segments, joins them with a
// straight vertical divider, and owns the border + corner radius. One segment =
// a plain single rounded chip.
export function ChipGroup(props: { children: JSX.Element; class?: string }) {
  return (
    <span
      data-component="chip-group"
      class={
        "inline-flex items-stretch rounded-md border border-border-weak-base bg-surface-inset-base " +
        "overflow-hidden [&>[data-slot=chip]+[data-slot=chip]]:border-l " +
        "[&>[data-slot=chip]+[data-slot=chip]]:border-border-weak-base " +
        (props.class ?? "")
      }
    >
      {props.children}
    </span>
  )
}
