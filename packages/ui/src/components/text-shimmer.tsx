import { ComponentProps, JSX } from "solid-js"

// Animated shimmer text for live "working" states (e.g. a tool call whose
// arguments are still streaming). A highlight band sweeps across the glyphs to
// signal activity without a spinner. See [data-component="text-shimmer"] in
// styles/animations.css for the gradient/background-clip technique.
export function TextShimmer(props: {
  children: JSX.Element
  // Seconds for one sweep. Lower = faster.
  duration?: number
  // Half-width of the highlight band as a % of the text (larger = wider glow).
  spread?: number
  base?: string
  highlight?: string
  class?: string
  style?: ComponentProps<"span">["style"]
}) {
  return (
    <span
      data-component="text-shimmer"
      class={props.class}
      style={{
        "--shimmer-duration": `${props.duration ?? 2}s`,
        "--shimmer-spread": `${props.spread ?? 15}%`,
        "--shimmer-base": props.base ?? "var(--text-weak)",
        "--shimmer-highlight": props.highlight ?? "var(--text-base)",
        ...(props.style as object),
      }}
    >
      {props.children}
    </span>
  )
}
