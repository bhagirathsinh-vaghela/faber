import { Button as Kobalte } from "@kobalte/core/button"
import { type ComponentProps, splitProps } from "solid-js"
import { Icon, IconProps } from "./icon"

export interface IconButtonProps extends ComponentProps<typeof Kobalte> {
  icon: IconProps["name"]
  size?: "normal" | "large"
  iconSize?: IconProps["size"]
  variant?: "primary" | "secondary" | "ghost"
}

export function IconButton(props: ComponentProps<"button"> & IconButtonProps) {
  const [split, rest] = splitProps(props, ["variant", "size", "iconSize", "class", "classList", "onMouseDown"])
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
      data-component="icon-button"
      data-size={split.size || "normal"}
      data-variant={split.variant || "secondary"}
      classList={{
        ...(split.classList ?? {}),
        [split.class ?? ""]: !!split.class,
      }}
    >
      <Icon name={props.icon} size={split.iconSize ?? (split.size === "large" ? "normal" : "small")} />
    </Kobalte>
  )
}
