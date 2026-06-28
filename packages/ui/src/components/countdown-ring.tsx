// Compact depleting-arc ring for the cache-expiry countdown chip.
// Mirrors the question-panel ring: a faint full track + a colored arc that
// depletes clockwise from 12 o'clock as `fraction` (remaining, 0–1) drops.
// pathLength=100 keeps the dash math size-independent. Sized to sit inline in a
// chip's icon slot — no number inside (the chip text carries the time).
//
// Token-driven: track from --border-weak-base; the arc color is passed in
// (`color`, a raw CSS color or var) so the caller can sweep it with the cache
// state. Default arc = --usage-cached (the "fresh cache" green).

export function CountdownRing(props: { fraction: number; color?: string; class?: string }) {
  return (
    <svg
      data-component="countdown-ring"
      viewBox="0 0 36 36"
      class={`-rotate-90 ${props.class ?? "size-3.5"}`}
      fill="none"
    >
      <circle cx="18" cy="18" r="16" fill="none" stroke="var(--border-weak-base)" stroke-width="4" />
      <circle
        cx="18"
        cy="18"
        r="16"
        fill="none"
        stroke={props.color ?? "var(--usage-cached)"}
        stroke-width="4"
        stroke-linecap="round"
        pathLength="100"
        stroke-dasharray="100"
        stroke-dashoffset={100 * (1 - Math.max(0, Math.min(1, props.fraction)))}
        style={{ transition: "stroke-dashoffset 1s linear, stroke 0.5s linear" }}
      />
    </svg>
  )
}
