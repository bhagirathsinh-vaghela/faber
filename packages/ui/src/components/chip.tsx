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
  class?: string
  title?: string
}

const base =
  "inline-flex items-center gap-1 rounded-md border border-border-weak-base " +
  "bg-surface-inset-base px-1.5 py-0.5 text-[11px] leading-tight " +
  "[font-variant-numeric:tabular-nums] whitespace-nowrap"

export function Chip(props: ChipProps) {
  const [local, rest] = splitProps(props, ["icon", "children", "accent", "onClick", "class", "title"])

  const content = (
    <>
      <Show when={local.icon}>
        <span class="inline-flex shrink-0 items-center" data-slot="chip-icon">
          {local.icon}
        </span>
      </Show>
      <span
        data-slot="chip-content"
        style={local.accent ? { color: `var(--${local.accent})` } : undefined}
      >
        {local.children}
      </span>
    </>
  )

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
