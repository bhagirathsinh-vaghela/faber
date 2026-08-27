import { Button as Kobalte } from "@kobalte/core/button"
import { type ComponentProps, Show, splitProps } from "solid-js"
import { Icon, IconProps } from "./icon"

export interface ButtonProps
  extends ComponentProps<typeof Kobalte>,
    Pick<ComponentProps<"button">, "class" | "classList" | "children"> {
  size?: "small" | "normal" | "large"
  variant?: "primary" | "secondary" | "ghost"
  icon?: IconProps["name"]
}

export function Button(props: ButtonProps) {
  const [split, rest] = splitProps(props, ["variant", "size", "icon", "class", "classList", "onMouseDown"])
  return (
    <Kobalte
      {...rest}
      onMouseDown={(event: MouseEvent) => {
        // Taking focus blurs whatever the user was typing in, and WebKit spends
        // the tap on that blur rather than delivering the click. Cancelling the
        // focus shift keeps the first press working; click is not a default
        // action of mousedown, so it still fires. A control that opens a
        // popup is exempt: it needs the focus it is about to hand to the menu.
        if (!(event.currentTarget as HTMLElement)?.hasAttribute("aria-haspopup")) event.preventDefault()
        ;(split.onMouseDown as ((e: MouseEvent) => void) | undefined)?.(event)
      }}
      data-component="button"
      data-size={split.size || "normal"}
      data-variant={split.variant || "secondary"}
      data-icon={split.icon}
      classList={{
        ...(split.classList ?? {}),
        [split.class ?? ""]: !!split.class,
      }}
    >
      <Show when={split.icon}>
        <Icon name={split.icon!} size="small" />
      </Show>
      {props.children}
    </Kobalte>
  )
}
