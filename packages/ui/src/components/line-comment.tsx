import { onMount, Show, splitProps, type JSX } from "solid-js"
import { Popover } from "@kobalte/core/popover"
import { Button } from "./button"
import { Icon } from "./icon"
import { useI18n } from "../context/i18n"

export type LineCommentVariant = "default" | "editor"

export type LineCommentAnchorProps = {
  id?: string
  top?: number
  open: boolean
  variant?: LineCommentVariant
  onOpenChange?: (open: boolean) => void
  onClick?: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent>
  onMouseEnter?: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent>
  class?: string
  popoverClass?: string
  children: JSX.Element
}

export const LineCommentAnchor = (props: LineCommentAnchorProps) => {
  // The small marker button stays line-anchored via `top` (20px, never
  // overflows). Only the card is a Kobalte popover: portaled out of the diff
  // wrapper's overflow:hidden and reactively placed (flip/shift) against the
  // button, so a narrow column can no longer push it over the code or clip it.
  const hidden = () => props.top === undefined
  const variant = () => props.variant ?? "default"

  return (
    <div
      data-component="line-comment"
      data-variant={variant()}
      data-comment-id={props.id}
      data-open={props.open ? "" : undefined}
      classList={{
        [props.class ?? ""]: !!props.class,
      }}
      style={{
        top: `${props.top ?? 0}px`,
        opacity: hidden() ? 0 : 1,
        "pointer-events": hidden() ? "none" : "auto",
      }}
    >
      <Popover
        open={props.open}
        onOpenChange={props.onOpenChange}
        placement="bottom-start"
        gutter={6}
        overflowPadding={12}
        flip
        modal={false}
      >
        <Popover.Anchor
          as="button"
          type="button"
          data-slot="line-comment-button"
          onClick={props.onClick}
          onMouseEnter={props.onMouseEnter}
        >
          <Icon name="comment" size="small" />
        </Popover.Anchor>
        <Popover.Portal>
          <Popover.Content
            data-slot="line-comment-popover"
            data-variant={variant()}
            classList={{
              [props.popoverClass ?? ""]: !!props.popoverClass,
            }}
          >
            {props.children}
          </Popover.Content>
        </Popover.Portal>
      </Popover>
    </div>
  )
}

export type LineCommentProps = Omit<LineCommentAnchorProps, "children" | "variant"> & {
  comment: JSX.Element
  selection: JSX.Element
}

export const LineComment = (props: LineCommentProps) => {
  const i18n = useI18n()
  const [split, rest] = splitProps(props, ["comment", "selection"])

  return (
    <LineCommentAnchor {...rest} variant="default">
      <div data-slot="line-comment-content">
        <div data-slot="line-comment-text">{split.comment}</div>
        <div data-slot="line-comment-label">
          {i18n.t("ui.lineComment.label.prefix")}
          {split.selection}
          {i18n.t("ui.lineComment.label.suffix")}
        </div>
      </div>
    </LineCommentAnchor>
  )
}

export type LineCommentEditorProps = Omit<LineCommentAnchorProps, "children" | "open" | "variant" | "onClick"> & {
  value: string
  selection: JSX.Element
  onInput: (value: string) => void
  onCancel: VoidFunction
  onSubmit: (value: string) => void
  placeholder?: string
  rows?: number
  autofocus?: boolean
  cancelLabel?: string
  submitLabel?: string
}

export const LineCommentEditor = (props: LineCommentEditorProps) => {
  const i18n = useI18n()
  const [split, rest] = splitProps(props, [
    "value",
    "selection",
    "onInput",
    "onCancel",
    "onSubmit",
    "placeholder",
    "rows",
    "autofocus",
    "cancelLabel",
    "submitLabel",
  ])

  const refs = {
    textarea: undefined as HTMLTextAreaElement | undefined,
    editor: undefined as HTMLDivElement | undefined,
  }

  const focus = () => refs.textarea?.focus()

  const submit = () => {
    const value = split.value.trim()
    if (!value) return
    split.onSubmit(value)
  }

  // A draft only survives while it is being composed. The moment focus leaves
  // the editor without a submit (click into the diff, scroll away, focus
  // elsewhere), drop it so the highlight and marker never linger unposted.
  // A blur into the editor's own buttons (Cancel/Submit) stays: their click
  // handlers own the outcome.
  const dismissOnBlur = (e: FocusEvent) => {
    const next = e.relatedTarget
    if (next instanceof Node && refs.editor?.contains(next)) return
    split.onCancel()
  }

  onMount(() => {
    if (split.autofocus === false) return
    requestAnimationFrame(focus)
  })

  return (
    <LineCommentAnchor
      {...rest}
      open={true}
      variant="editor"
      onClick={() => focus()}
      onOpenChange={(open) => {
        if (!open) split.onCancel()
      }}
    >
      <div
        data-slot="line-comment-editor"
        ref={(el) => {
          refs.editor = el
        }}
      >
        <textarea
          ref={(el) => {
            refs.textarea = el
          }}
          data-slot="line-comment-textarea"
          rows={split.rows ?? 3}
          placeholder={split.placeholder ?? i18n.t("ui.lineComment.placeholder")}
          value={split.value}
          onInput={(e) => split.onInput(e.currentTarget.value)}
          onBlur={dismissOnBlur}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault()
              e.stopPropagation()
              split.onCancel()
              return
            }
            if (e.key !== "Enter") return
            if (e.shiftKey) return
            e.preventDefault()
            e.stopPropagation()
            submit()
          }}
        />
        <div data-slot="line-comment-actions">
          <div data-slot="line-comment-editor-label">
            {i18n.t("ui.lineComment.editorLabel.prefix")}
            {split.selection}
            {i18n.t("ui.lineComment.editorLabel.suffix")}
          </div>
          <Button size="small" variant="ghost" onClick={split.onCancel}>
            {split.cancelLabel ?? i18n.t("ui.common.cancel")}
          </Button>
          <Button size="small" variant="primary" disabled={split.value.trim().length === 0} onClick={submit}>
            {split.submitLabel ?? i18n.t("ui.lineComment.submit")}
          </Button>
        </div>
      </div>
    </LineCommentAnchor>
  )
}
