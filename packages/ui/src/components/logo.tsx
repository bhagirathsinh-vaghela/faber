export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path data-slot="logo-logo-mark-f" d="M0 0H16V4H4V8H12V12H4V20H0V0Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}
