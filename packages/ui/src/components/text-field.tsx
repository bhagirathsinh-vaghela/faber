import { TextField as Kobalte } from "@kobalte/core/text-field"
import { createSignal, Show, splitProps } from "solid-js"
import type { ComponentProps } from "solid-js"
import { useI18n } from "../context/i18n"
import { IconButton } from "./icon-button"
import { Tooltip } from "./tooltip"
import { createCoarsePointer } from "../util/mobile"

export interface TextFieldProps
  extends ComponentProps<typeof Kobalte.Input>,
    Partial<
      Pick<
        ComponentProps<typeof Kobalte>,
        | "name"
        | "defaultValue"
        | "value"
        | "onChange"
        | "onKeyDown"
        | "validationState"
        | "required"
        | "disabled"
        | "readOnly"
      >
    > {
  label?: string
  hideLabel?: boolean
  description?: string
  error?: string
  variant?: "normal" | "ghost"
  copyable?: boolean
  multiline?: boolean
  // On touch devices the OS keyboard is suppressed by default (inputmode=none)
  // so focusing a field doesn't fight dictation or shove the layout; a toggle
  // inside the field raises it per focus. Pass false where typing is the point
  // (e.g. an inline rename) so the keyboard rises normally.
  suppressKeyboard?: boolean
}

export function TextField(props: TextFieldProps) {
  const i18n = useI18n()
  const [local, others] = splitProps(props, [
    "name",
    "defaultValue",
    "value",
    "onChange",
    "onKeyDown",
    "validationState",
    "required",
    "disabled",
    "readOnly",
    "class",
    "label",
    "hideLabel",
    "description",
    "error",
    "variant",
    "copyable",
    "multiline",
    "suppressKeyboard",
    "inputmode",
    "onBlur",
    "ref",
  ])
  const [copied, setCopied] = createSignal(false)

  const coarse = createCoarsePointer()
  const [keyboardWanted, setKeyboardWanted] = createSignal(false)
  const suppress = () => (local.suppressKeyboard ?? true) && coarse() && !keyboardWanted()
  let inputRef: HTMLInputElement | HTMLTextAreaElement | undefined
  const captureRef = (el: HTMLInputElement | HTMLTextAreaElement) => {
    inputRef = el
    const ref = local.ref
    if (typeof ref === "function") (ref as (el: HTMLInputElement | HTMLTextAreaElement) => void)(el)
  }
  const requestKeyboard = () => {
    setKeyboardWanted(true)
    requestAnimationFrame(() => inputRef?.focus())
  }
  const handleBlur = (event: FocusEvent & { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
    setKeyboardWanted(false)
    const onBlur = local.onBlur
    if (typeof onBlur === "function") (onBlur as (e: typeof event) => void)(event)
  }

  async function handleCopy() {
    const value = local.value ?? local.defaultValue ?? ""
    await navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function handleClick() {
    if (local.copyable) handleCopy()
  }

  return (
    <Kobalte
      data-component="input"
      data-variant={local.variant || "normal"}
      name={local.name}
      defaultValue={local.defaultValue}
      value={local.value}
      onChange={local.onChange}
      onKeyDown={local.onKeyDown}
      onClick={handleClick}
      required={local.required}
      disabled={local.disabled}
      readOnly={local.readOnly}
      validationState={local.validationState}
    >
      <Show when={local.label}>
        <Kobalte.Label data-slot="input-label" classList={{ "sr-only": local.hideLabel }}>
          {local.label}
        </Kobalte.Label>
      </Show>
      <div data-slot="input-wrapper">
        <Show
          when={local.multiline}
          fallback={
            <Kobalte.Input
              {...others}
              ref={captureRef}
              onBlur={handleBlur}
              inputmode={suppress() ? "none" : local.inputmode}
              data-slot="input-input"
              class={local.class}
            />
          }
        >
          <Kobalte.TextArea
            {...others}
            ref={captureRef}
            onBlur={handleBlur}
            inputmode={suppress() ? "none" : local.inputmode}
            autoResize
            data-slot="input-input"
            class={local.class}
          />
        </Show>
        <Show when={suppress()}>
          <Tooltip value={i18n.t("ui.textField.showKeyboard")} placement="top" gutter={4}>
            <IconButton
              type="button"
              icon="keyboard"
              variant="ghost"
              // mousedown, not click: taking focus on click races the
              // requestKeyboard refocus. Prevent the default focus shift and
              // drive it ourselves so the caret stays in the field.
              onMouseDown={(e: MouseEvent) => {
                e.preventDefault()
                requestKeyboard()
              }}
              tabIndex={-1}
              data-slot="input-keyboard-button"
              aria-label={i18n.t("ui.textField.showKeyboard")}
            />
          </Tooltip>
        </Show>
        <Show when={local.copyable}>
          <Tooltip
            value={copied() ? i18n.t("ui.textField.copied") : i18n.t("ui.textField.copyLink")}
            placement="top"
            gutter={4}
            forceOpen={copied()}
            skipDelayDuration={0}
          >
            <IconButton
              type="button"
              icon={copied() ? "check" : "link"}
              variant="ghost"
              onClick={handleCopy}
              tabIndex={-1}
              data-slot="input-copy-button"
              aria-label={copied() ? i18n.t("ui.textField.copied") : i18n.t("ui.textField.copyLink")}
            />
          </Tooltip>
        </Show>
      </div>
      <Show when={local.description}>
        <Kobalte.Description data-slot="input-description">{local.description}</Kobalte.Description>
      </Show>
      <Kobalte.ErrorMessage data-slot="input-error">{local.error}</Kobalte.ErrorMessage>
    </Kobalte>
  )
}
