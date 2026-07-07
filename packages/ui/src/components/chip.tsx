import { type JSX, Show, splitProps } from "solid-js"
import { Tooltip } from "./tooltip"

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
  // that colors the icon and (unless valueAccent overrides) the value, so they
  // match by default. e.g. "usage-cached" → var(--usage-cached). Raw --<token>
  // because Tailwind v4 tree-shakes the --color-* aliases when only referenced
  // from inline styles; the theme loader always injects the raw var on :root.
  // Omit for the neutral text-strong color.
  accent?: string
  // Colors ONLY the value, splitting it from the icon. Used by gauge chips: the
  // icon keeps the utilization ramp (a danger cue) while the value goes neutral
  // so it stays legible over the colored fill instead of merging into it.
  // Defaults to `accent` when unset, so plain chips keep icon+value matching.
  valueAccent?: string
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
  // Rich tooltip content (styled popover with keybind hint). When set, the chip
  // wraps itself in <Tooltip>. The trigger wrapper uses display:contents so it
  // does not break the ChipGroup divider/border-collapse layout.
  tooltip?: JSX.Element
  tooltipPlacement?: "top" | "bottom" | "left" | "right"
}

const seg =
  // Fixed content height so plain chips and gauge chips (value + meter bar) are
  // the SAME height regardless of what's inside — content is vertically centered
  // in this box.
  "inline-flex items-center gap-1 px-1 py-px min-h-[20px] text-[length:var(--dock-font-size)] leading-tight font-mono " +
  "[font-weight:var(--dock-font-weight)] [font-variant-numeric:tabular-nums] whitespace-nowrap"

// A single metric segment. Lives inside a ChipGroup. Carries its own accent
// color (icon + value) and optional gauge fill. No border/radius of its own —
// the group owns those; dividers between segments are drawn by the group.
export function Chip(props: ChipProps) {
  const [local, rest] = splitProps(props, [
    "icon",
    "children",
    "accent",
    "valueAccent",
    "onClick",
    "fill",
    "fillColor",
    "class",
    "title",
    "tooltip",
    "tooltipPlacement",
  ])

  const iconTone = () => (local.accent ? `var(--${local.accent})` : "var(--color-text-strong)")
  const valueTone = () =>
    local.valueAccent ? `var(--${local.valueAccent})` : local.accent ? `var(--${local.accent})` : "var(--color-text-strong)"

  // Utilization as a percentage 0..100, or undefined for non-gauge chips.
  const gaugePct = () => (local.fill === undefined ? undefined : Math.max(0, Math.min(1, local.fill)) * 100)

  // The meter bar (Intent-style: rounded track + rounded colored fill) sits
  // directly UNDER the value, only as wide as the value column, so text stays
  // clear of the fill and keeps its identity color at full legibility.
  // Gauge chips pass a fill; plain chips render the SAME bar
  // fully transparent so both chip types share identical layout — the value gets
  // pushed up by the bar's height either way, keeping value baselines aligned
  // across the row with no manual spacing math.
  const gaugeBar = () => {
    const pct = gaugePct()
    const visible = pct !== undefined
    const tint = local.fillColor ? `var(--${local.fillColor})` : "var(--color-text-base)"
    return (
      <span
        data-slot="chip-gauge"
        class="block h-[2px] w-full overflow-hidden rounded-full"
        classList={{ "bg-border-weak-base": visible, "bg-transparent": !visible }}
      >
        <Show when={visible}>
          <span class="block h-full rounded-full" style={{ width: `${pct}%`, "background-color": tint }} />
        </Show>
      </span>
    )
  }

  // Every chip stacks value above the bar (real on gauge chips, transparent on
  // plain ones) so the layout — and thus the value baseline — is identical.
  const value = () => (
    <Show when={local.children !== undefined}>
      <span class="inline-flex flex-col justify-center gap-0 leading-none">
        <span data-slot="chip-content" class="leading-none" style={{ color: valueTone() }}>
          {local.children}
        </span>
        {gaugeBar()}
      </span>
    </Show>
  )

  const content = (
    <span class="inline-flex items-center gap-1">
      <Show when={local.icon}>
        <span
          class="inline-flex size-3.5 shrink-0 items-center justify-center [&_[data-component=icon]]:!text-current [&_[data-component=icon]]:!size-full [&_[data-slot=icon-svg]]:!size-full [&_:is(path,circle,rect,line,ellipse,polyline,polygon)]:![stroke-width:2.6]"
          data-slot="chip-icon"
          style={{ color: iconTone() }}
        >
          {local.icon}
        </span>
      </Show>
      {value()}
    </span>
  )

  const cls = `${seg} relative overflow-hidden ${local.class ?? ""}`

  const chip = (
    <Show
      when={local.onClick}
      fallback={
        <span data-slot="chip" title={local.title} class={cls} {...rest}>
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
        class={`${cls} cursor-pointer hover:bg-surface-raised-base-hover`}
        {...rest}
      >
        {content}
      </button>
    </Show>
  )

  return (
    <Show when={local.tooltip} fallback={chip}>
      <Tooltip value={local.tooltip} placement={local.tooltipPlacement ?? "top"} class="inline-flex items-stretch">
        {chip}
      </Tooltip>
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
        // Dividers between adjacent segments. Two adjacency cases: bare chips
        // (direct [data-slot=chip] children) and tooltip-wrapped chips (the chip
        // sits inside an inline-flex [data-component=tooltip-trigger], which is
        // the flex segment and carries the divider border itself).
        "overflow-hidden [&>[data-slot=chip]+[data-slot=chip]]:border-l " +
        "[&>[data-slot=chip]+[data-slot=chip]]:border-border-weak-base " +
        "[&>[data-component=tooltip-trigger]+[data-component=tooltip-trigger]]:border-l " +
        "[&>[data-component=tooltip-trigger]+[data-component=tooltip-trigger]]:border-border-weak-base " +
        (props.class ?? "")
      }
    >
      {props.children}
    </span>
  )
}
