import { type JSX, Show, splitProps } from "solid-js"

// Shared status/metric pill. Used by the usage dock, per-message
// footer, and prompt action bar. Subtle weight by design: faint inset surface +
// hairline border so the metric colors (icon/value) carry the signal, not the
// container. Interactive chips render as a <button> with a hover state and a
// touch-friendly min height; static chips render as a <span>.
//
// Styling is fully token-driven (no hardcoded color): surface from
// --color-surface-inset-base, border from --color-border-weak-base. An optional
// `accent` token tints the value text (e.g. "usage-cache-write").

export type ChipProps = {
  // Leading slot — typically the metric icon.
  icon?: JSX.Element
  // Main content — label + value.
  children: JSX.Element
  // Raw theme token name (the runtime CSS var, NOT the --color- Tailwind alias)
  // to tint the content, e.g. "usage-cache-write" → var(--usage-cache-write).
  // We use the raw var because Tailwind v4 tree-shakes the --color-* aliases
  // unless a utility class references them; inline styles don't count, so the
  // alias would resolve to nothing. The raw --<token> is injected on :root by
  // the theme loader at runtime and always exists.
  accent?: string
  // When set, the chip is interactive (renders a <button>).
  onClick?: (e: MouseEvent) => void
  // Fraction 0..1 for "value out of a max" metrics (e.g. context).
  // When set, the chip's border becomes a gauge: a conic sweep fills the
  // perimeter clockwise from 12 o'clock proportional to the fraction. The text
  // carries the numbers; the border carries fullness, so it never looks empty
  // or broken at low fractions (unlike a thin bar). `fillColor` tints the
  // filled arc (defaults to the accent token); the unfilled arc is a muted
  // track.
  fill?: number
  fillColor?: string
  class?: string
  title?: string
}

const base =
  "inline-flex items-center gap-1 rounded-md border border-border-weak-base " +
  "bg-surface-inset-base px-1.5 py-0.5 text-[12px] leading-tight " +
  "[font-variant-numeric:tabular-nums] whitespace-nowrap"

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

  // Icon and text share one neutral color (text-strong, same as the Build/model
  // pickers) — consistent across all chips and never shifting with fill level.
  // The fill (background) carries the metric color, not the content. Bold weight
  // + thicker icon stroke + a dark halo keep both crisp and legible over the fill.
  const halo = "0 1px 3px rgba(0,0,0,0.85), 0 0 2px rgba(0,0,0,0.7)"
  const content = (
    <span class="inline-flex items-center gap-1 text-text-strong">
      <Show when={local.icon}>
        <span
          class="inline-flex shrink-0 items-center [&_[data-component=icon]]:text-text-strong"
          data-slot="chip-icon"
          style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.85))" }}
        >
          {local.icon}
        </span>
      </Show>
      <span class="font-extrabold" data-slot="chip-content" style={{ "text-shadow": halo }}>
        {local.children}
      </span>
    </span>
  )

  // Gauge variant: the chip background fills left-to-right to `fill` (the proven
  // pattern — Copilot's ████░░░░, LibreChat's gauge — not a conic perimeter,
  // which doesn't read as a quantity). The filled band is a translucent tint of
  // the fill color so the text stays legible on top; an opaque thin leading edge
  // marks the boundary. Numbers live in the text, fullness in the fill. Clamped
  // to [0,1].
  if (local.fill !== undefined) {
    const pct = () => Math.max(0, Math.min(1, local.fill ?? 0)) * 100
    const tint = () => (local.fillColor ? `var(--${local.fillColor})` : "var(--color-text-base)")
    // color-mix keeps the fill subtle enough to read text over; the track is the
    // normal inset surface.
    const fillBg = () =>
      `linear-gradient(to right, color-mix(in srgb, ${tint()} 28%, transparent) ${pct()}%, transparent ${pct()}%)`
    return (
      <span
        data-component="chip"
        data-gauge="true"
        title={local.title}
        class={`${base} relative overflow-hidden ${local.class ?? ""}`}
        style={{ "background-image": fillBg() }}
        {...rest}
      >
        {content}
      </span>
    )
  }

  return (
    <Show
      when={local.onClick}
      fallback={
        <span data-component="chip" title={local.title} class={`${base} ${local.class ?? ""}`} {...rest}>
          {content}
        </span>
      }
    >
      <button
        type="button"
        data-component="chip"
        data-interactive="true"
        title={local.title}
        onClick={local.onClick}
        class={`${base} min-h-[22px] cursor-pointer transition-colors hover:bg-surface-inset-base-hover hover:border-border-weak-hover ${local.class ?? ""}`}
        {...rest}
      >
        {content}
      </button>
    </Show>
  )
}
