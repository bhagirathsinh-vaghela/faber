import {
  Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  Show,
  Switch,
  onCleanup,
  type JSX,
} from "solid-js"
import stripAnsi from "strip-ansi"
import { Dynamic } from "solid-js/web"
import {
  AgentPart,
  AssistantMessage,
  FilePart,
  Message as MessageType,
  Part as PartType,
  ReasoningPart,
  TextPart,
  ToolPart,
  UserMessage,
  Todo,
  QuestionAnswer,
  QuestionInfo,
} from "@opencode-ai/sdk/v2"
import { useData } from "../context"
import { useDiffComponent } from "../context/diff"
import { useCodeComponent } from "../context/code"
import { useDialog } from "../context/dialog"
import { Dialog } from "./dialog"
import { useI18n } from "../context/i18n"
import { BasicTool } from "./basic-tool"
import { GenericTool } from "./basic-tool"
import { TextShimmer } from "./text-shimmer"
import { Button } from "./button"
import { Card } from "./card"
import { Icon } from "./icon"
import { Checkbox } from "./checkbox"
import { DiffChanges } from "./diff-changes"
import { Markdown } from "./markdown"
import { ImagePreview } from "./image-preview"
import { findLast } from "@opencode-ai/util/array"
import { getDirectory as _getDirectory, getFilename } from "@opencode-ai/util/path"
import { checksum } from "@opencode-ai/util/encode"
import { Tooltip } from "./tooltip"
import { CopyButton } from "./copy-button"

interface Diagnostic {
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  message: string
  severity?: number
}

function getDiagnostics(
  diagnosticsByFile: Record<string, Diagnostic[]> | undefined,
  filePath: string | undefined,
): Diagnostic[] {
  if (!diagnosticsByFile || !filePath) return []
  const diagnostics = diagnosticsByFile[filePath] ?? []
  return diagnostics.filter((d) => d.severity === 1).slice(0, 3)
}

function DiagnosticsDisplay(props: { diagnostics: Diagnostic[] }): JSX.Element {
  const i18n = useI18n()
  return (
    <Show when={props.diagnostics.length > 0}>
      <div data-component="diagnostics">
        <For each={props.diagnostics}>
          {(diagnostic) => (
            <div data-slot="diagnostic">
              <span data-slot="diagnostic-label">{i18n.t("ui.messagePart.diagnostic.error")}</span>
              <span data-slot="diagnostic-location">
                [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}]
              </span>
              <span data-slot="diagnostic-message">{diagnostic.message}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

export interface MessageProps {
  message: MessageType
  parts: PartType[]
  // When set, renders the message inside a TUI-style bordered, agent-tinted
  // box with a "◈ ROLE" header.
  boxed?: boolean
  defaultOpen?: boolean
  // Completed-turn snapshot line, threaded from the page down to each
  // assistant text box. Absent while the turn is streaming.
  footer?: (message: AssistantMessage) => JSX.Element
  // Extra control for the boxed header's actions row (sticky expand chevron).
  action?: JSX.Element
  // When set, the box header's identity (◈ #N ROLE time) becomes a button that
  // scrolls this message into view. Used by the sticky user-message header.
  onJump?: () => void
}

function messageTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`
}

export interface MessagePartProps {
  part: PartType
  message: MessageType
  hideDetails?: boolean
  defaultOpen?: boolean
  // Completed-turn snapshot line; only TextPartDisplay renders it (under its
  // own box). Every other part ignores it.
  footer?: (message: AssistantMessage) => JSX.Element
}

export type PartComponent = Component<MessagePartProps>

export const PART_MAPPING: Record<string, PartComponent | undefined> = {}

const TEXT_RENDER_THROTTLE_MS = 100

function same<T>(a: readonly T[], b: readonly T[]) {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

function createThrottledValue(getValue: () => string) {
  const [value, setValue] = createSignal(getValue())
  let timeout: ReturnType<typeof setTimeout> | undefined
  let last = 0

  createEffect(() => {
    const next = getValue()
    const now = Date.now()
    const remaining = TEXT_RENDER_THROTTLE_MS - (now - last)
    if (remaining <= 0) {
      if (timeout) {
        clearTimeout(timeout)
        timeout = undefined
      }
      last = now
      setValue(next)
      return
    }
    if (timeout) clearTimeout(timeout)
    timeout = setTimeout(() => {
      last = Date.now()
      setValue(next)
      timeout = undefined
    }, remaining)
  })

  onCleanup(() => {
    if (timeout) clearTimeout(timeout)
  })

  return value
}

function relativizeProjectPaths(text: string, directory?: string) {
  if (!text) return ""
  if (!directory) return text
  return text.split(directory).join("")
}

function getDirectory(path: string | undefined) {
  const data = useData()
  return relativizeProjectPaths(_getDirectory(path), data.directory)
}

export function getSessionToolParts(store: ReturnType<typeof useData>["store"], sessionId: string): ToolPart[] {
  const messages = store.message[sessionId]?.filter((m) => m.role === "assistant")
  if (!messages) return []

  const parts: ToolPart[] = []
  for (const m of messages) {
    const msgParts = store.part[m.id]
    if (msgParts) {
      for (const p of msgParts) {
        if (p && p.type === "tool") parts.push(p as ToolPart)
      }
    }
  }
  return parts
}

import type { IconProps } from "./icon"

export type ToolInfo = {
  icon: IconProps["name"]
  title: string
  subtitle?: string
}

export function getToolInfo(tool: string, input: any = {}): ToolInfo {
  const i18n = useI18n()
  switch (tool) {
    case "read":
      return {
        icon: "glasses",
        title: i18n.t("ui.tool.read"),
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "list":
      return {
        icon: "bullet-list",
        title: i18n.t("ui.tool.list"),
        subtitle: input.path ? getFilename(input.path) : undefined,
      }
    case "glob":
      return {
        icon: "magnifying-glass-menu",
        title: i18n.t("ui.tool.glob"),
        subtitle: input.pattern,
      }
    case "grep":
      return {
        icon: "magnifying-glass-menu",
        title: i18n.t("ui.tool.grep"),
        subtitle: input.pattern,
      }
    case "webfetch":
      return {
        icon: "window-cursor",
        title: i18n.t("ui.tool.webfetch"),
        subtitle: input.url,
      }
    case "task":
      return {
        icon: "task",
        title: i18n.t("ui.tool.agent", { type: input.subagent_type || "task" }),
        subtitle: input.description,
      }
    case "bash":
      return {
        icon: "console",
        title: i18n.t("ui.tool.shell"),
        subtitle: input.description,
      }
    case "edit":
      return {
        icon: "code-lines",
        title: i18n.t("ui.messagePart.title.edit"),
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "write":
      return {
        icon: "code-lines",
        title: i18n.t("ui.messagePart.title.write"),
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "apply_patch":
      return {
        icon: "code-lines",
        title: i18n.t("ui.tool.patch"),
        subtitle: input.files?.length
          ? `${input.files.length} ${i18n.t(input.files.length > 1 ? "ui.common.file.other" : "ui.common.file.one")}`
          : undefined,
      }
    case "todowrite":
      return {
        icon: "checklist",
        title: i18n.t("ui.tool.todos"),
      }
    case "todoread":
      return {
        icon: "checklist",
        title: i18n.t("ui.tool.todos.read"),
      }
    case "question":
      return {
        icon: "bubble-5",
        title: i18n.t("ui.tool.questions"),
      }
    case "skill":
      return {
        icon: "code-lines",
        title: i18n.t("ui.tool.skill"),
        subtitle: input.name,
      }
    default:
      return {
        icon: "mcp",
        title: tool,
      }
  }
}

export function registerPartComponent(type: string, component: PartComponent) {
  PART_MAPPING[type] = component
}

function taskResultPart(parts: PartType[]): TextPart | undefined {
  return parts.find((p) => p.type === "text" && (p as TextPart).backgroundTaskResult) as TextPart | undefined
}

const TASK_ACCENT = "var(--box-accent-task)"

function taskAccent(status: string): string {
  return status === "failed" ? "var(--color-text-error)" : TASK_ACCENT
}

function stripTaskMeta(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim()
      // The opaque IDs carry nothing a reader can act on. Everything else
      // (agent, toolset, summary, status, duration) is surfaced as styled
      // fields, so it comes OUT of the raw body and renders as UI instead.
      if (trimmed.startsWith("task_id:")) return false
      if (trimmed.startsWith("session_id:")) return false
      if (trimmed.startsWith("Background task started:")) return false
      if (trimmed.startsWith("agent:")) return false
      if (trimmed.startsWith("toolset:")) return false
      if (trimmed.startsWith("summary:")) return false
      if (trimmed.startsWith("type: subagent")) return false
      if (trimmed.startsWith("status:")) return false
      if (trimmed.startsWith("duration:")) return false
      if (trimmed === "Results will be delivered when the task completes.") return false
      return true
    })
    .join("\n")
    .trim()
}

function stripTaskResult(text: string): string {
  const match = text.match(/<background-task-result>([\s\S]*?)<\/background-task-result>/)
  return stripTaskMeta(match ? match[1] : text)
}

function stripTaskOutput(text: string): string {
  const cleaned = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<task_metadata>[\s\S]*?<\/task_metadata>/g, "")
    .trim()
  return stripTaskMeta(cleaned)
}

// Ring-dot separator, same as the assistant footer chip line.
function TaskDot() {
  return (
    <span
      class="mx-2 inline-block size-[4px] rounded-full border align-middle"
      style={{ "border-color": "var(--text-weaker)" }}
    />
  )
}

function taskStatusColor(status: string): string {
  if (status === "failed") return "var(--syntax-critical)"
  if (status === "cancelled") return "var(--text-weak)"
  return "var(--syntax-string)"
}

function taskDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
}

// Fields matched to the footer chip line: agent=type, subagent kind=constant,
// status=state color, duration=number. Every field the reader saw before stays,
// now colored by its semantic token instead of flat gray.
function TaskResultDisplay(props: { part: TextPart }) {
  const meta = () => props.part.backgroundTaskResult!
  const content = createMemo(() => stripTaskResult(props.part.text))
  const fields = createMemo(() => {
    const m = meta()
    const result: { color: string; text: string }[] = []
    if (m.agent) result.push({ color: "var(--syntax-type)", text: m.agent })
    result.push({ color: "var(--syntax-constant)", text: m.type })
    result.push({ color: taskStatusColor(m.status), text: m.status })
    result.push({ color: "var(--syntax-primitive)", text: taskDuration(m.duration) })
    return result
  })
  return (
    <div data-component="task-result" data-scrollable>
      <div
        data-slot="task-result-meta"
        class="mb-2 flex flex-row flex-wrap items-center font-mono"
        style={{ "font-size": "11px", "line-height": "1.2" }}
      >
        <For each={fields()}>
          {(field, i) => (
            <>
              <Show when={i() > 0}>
                <TaskDot />
              </Show>
              <span class="font-medium" style={{ color: field.color }}>
                {field.text}
              </span>
            </>
          )}
        </For>
      </div>
      <Markdown text={content()} cacheKey={props.part.id} />
    </div>
  )
}

export function Message(props: MessageProps) {
  return (
    <Switch>
      <Match when={props.message.role === "user" && taskResultPart(props.parts)}>
        {(part) => (
          <Show when={props.boxed} fallback={<TaskResultDisplay part={part()} />}>
            <MessageBox
              message={props.message}
              label="TASK RESULT"
              accent={taskAccent(part().backgroundTaskResult!.status)}
              action={props.action}
              onJump={props.onJump}
            >
              <TaskResultDisplay part={part()} />
            </MessageBox>
          </Show>
        )}
      </Match>
      <Match when={props.message.role === "user" && props.message}>
        {(userMessage) => (
          <Show
            when={props.boxed}
            fallback={<UserMessageDisplay message={userMessage() as UserMessage} parts={props.parts} />}
          >
            <MessageBox
              message={userMessage() as UserMessage}
              action={props.action}
              onJump={props.onJump}
              copy={() =>
                (props.parts.find((p) => p.type === "text" && !(p as TextPart).synthetic) as TextPart | undefined)
                  ?.text ?? ""
              }
            >
              <UserMessageDisplay message={userMessage() as UserMessage} parts={props.parts} />
            </MessageBox>
          </Show>
        )}
      </Match>
      <Match when={props.message.role === "assistant" && props.message}>
        {(assistantMessage) => (
          <AssistantMessageDisplay
            message={assistantMessage() as AssistantMessage}
            parts={props.parts}
            defaultOpen={props.defaultOpen}
            footer={props.footer}
          />
        )}
      </Match>
    </Switch>
  )
}

// TUI-style message box: rounded border + agent-tinted background + a
// "◈ USER" / "◈ ASSISTANT" header. User boxes use the agent color;
// assistant boxes use the success/green accent (mirrors the TUI).
export function MessageBox(props: {
  message: MessageType
  numberKey?: string
  label?: string
  accent?: string
  copy?: () => string
  // Extra control rendered inline in the title-bar actions row, after copy
  // (e.g. the collapse/expand chevron on sticky user messages).
  action?: JSX.Element
  // When set, the identity cluster (◈ #N ROLE time) becomes a button that
  // scrolls this message into view.
  onJump?: () => void
  children: JSX.Element
}) {
  const data = useData()
  const dialog = useDialog()
  const isUser = props.message.role === "user"

  function confirmRevert() {
    const doRevert = () => {
      dialog.close()
      data.revertMessage?.({ sessionID: props.message.sessionID, messageID: props.message.id })
    }
    // Enter-to-confirm: Kobalte owns dialog focus, so a global keydown for the
    // dialog's lifetime is more reliable than an element handler. Escape is
    // handled natively by Kobalte.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return
      e.preventDefault()
      document.removeEventListener("keydown", onKey)
      doRevert()
    }
    document.addEventListener("keydown", onKey)

    dialog.show(() => {
      onCleanup(() => document.removeEventListener("keydown", onKey))
      return (
        <Dialog title="Revert to this message?" fit>
          <div
            style={{ display: "flex", "flex-direction": "column", gap: "1rem", padding: "0 0.625rem 0.75rem 1.5rem" }}
          >
            <span style={{ color: "var(--color-text-strong)" }}>
              Roll the session back to this message. Later messages are undone; the cache is preserved.
            </span>
            <div style={{ display: "flex", "justify-content": "flex-end", gap: "0.5rem" }}>
              <Button variant="ghost" size="large" onClick={() => dialog.close()}>
                Cancel
              </Button>
              <Button variant="primary" size="large" onClick={doRevert}>
                Revert
              </Button>
            </div>
          </div>
        </Dialog>
      )
    })
  }
  const number = createMemo(() => data.blockNumber(props.message.sessionID, props.numberKey ?? props.message.id))
  const accent = props.accent ?? (isUser ? "var(--box-accent-user)" : "var(--box-accent-assistant)")
  // User and assistant boxes each get explicit, independently-customizable
  // border/bg tokens (user matches the assistant scheme with its own fixed
  // token set — no per-agent color). A caller-supplied accent (props.accent)
  // opts out and falls back to accent-derived border/bg in .accent-box.
  const boxTokens = props.accent
    ? {}
    : isUser
      ? { "--box-border": "var(--box-border-user)", "--box-bg": "var(--box-bg-user)" }
      : { "--box-border": "var(--box-border-assistant)", "--box-bg": "var(--box-bg-assistant)" }
  return (
    <div
      data-component="message-box"
      data-role={props.message.role}
      class="accent-box"
      style={{
        // Scheme (accent border, no fill) comes from .accent-box; this box only
        // supplies its accent + its own padding. Inter-box spacing comes from
        // the turn list's `gap`, same as tool boxes — no own bottom margin.
        "--box-accent": accent,
        ...boxTokens,
        padding: "0.5rem 0.75rem",
      }}
    >
      <div
        data-slot="message-box-header"
        style={{
          display: "flex",
          "align-items": "center",
          gap: "0.5rem",
          "margin-bottom": "0.375rem",
          color: accent,
          "font-size": "11px",
          "font-weight": "600",
          "letter-spacing": "0.04em",
        }}
      >
        <span
          data-slot="message-box-identity"
          // Sibling interactive control, not nested: the sticky bar's own click
          // handler skips [role='button'], so the two never double-fire. Jump
          // scrolls this message into view; the rest of the bar still toggles.
          role={props.onJump ? "button" : undefined}
          tabindex={props.onJump ? 0 : undefined}
          title={props.onJump ? "Scroll to this message" : undefined}
          style={{
            display: "flex",
            "align-items": "center",
            gap: "0.5rem",
            cursor: props.onJump ? "pointer" : undefined,
          }}
          onClick={
            props.onJump
              ? (event: MouseEvent) => {
                  event.stopPropagation()
                  props.onJump!()
                }
              : undefined
          }
          onKeyDown={
            props.onJump
              ? (event: KeyboardEvent) => {
                  if (event.key !== "Enter" && event.key !== " ") return
                  event.preventDefault()
                  event.stopPropagation()
                  props.onJump!()
                }
              : undefined
          }
        >
          <span data-slot="message-box-diamond">{"\u25c8"}</span>
          <Show when={number() !== undefined}>
            <span data-slot="message-box-number" style={{ color: "var(--color-text-weak)" }}>
              {"#" + number()}
            </span>
          </Show>
          <span data-slot="message-box-label">{props.label ?? (isUser ? "USER" : "ASSISTANT")}</span>
          <span data-slot="message-box-time" style={{ color: "var(--color-text-weak)", "font-weight": "400" }}>
            {messageTime(props.message.time.created)}
          </span>
        </span>
        {/* Title-bar actions, pinned right: revert (user, hover-reveal) then
            copy. Copy sits in the box's top-right corner for every box. */}
        <div
          data-slot="message-box-actions"
          style={{ "margin-left": "auto", display: "flex", "align-items": "center", gap: "0.25rem" }}
        >
          <Show when={isUser && data.revertMessage}>
            <div data-slot="message-box-revert">
              <Tooltip value="Cache-safe revert" placement="top" gutter={8}>
                <Button variant="secondary" size="small" onClick={confirmRevert}>
                  Revert here
                </Button>
              </Tooltip>
            </div>
          </Show>
          <Show when={props.copy}>
            <CopyButton content={props.copy!} />
          </Show>
          {props.action}
        </div>
      </div>
      {props.children}
    </div>
  )
}

function BlockNumber(props: { sessionID: string; id: string }) {
  const data = useData()
  const number = createMemo(() => data.blockNumber(props.sessionID, props.id))
  return (
    <Show when={number() !== undefined}>
      <span
        data-slot="block-number"
        style={{ color: "var(--color-text-weak)", "font-size": "11px", "font-weight": "600" }}
      >
        {"#" + number()}
      </span>
    </Show>
  )
}

export function AssistantMessageDisplay(props: {
  message: AssistantMessage
  parts: PartType[]
  defaultOpen?: boolean
  footer?: (message: AssistantMessage) => JSX.Element
}) {
  const emptyParts: PartType[] = []
  const filteredParts = createMemo(
    () =>
      props.parts.filter((x) => {
        return x.type !== "tool" || (x as ToolPart).tool !== "todoread"
      }),
    emptyParts,
    { equals: same },
  )
  return (
    <For each={filteredParts()}>
      {(part) => <Part part={part} message={props.message} defaultOpen={props.defaultOpen} footer={props.footer} />}
    </For>
  )
}

export function UserMessageDisplay(props: { message: UserMessage; parts: PartType[] }) {
  const dialog = useDialog()
  const i18n = useI18n()
  const [expanded, setExpanded] = createSignal(false)
  // The user prompt always renders in full — no clamp, no collapse. canExpand is
  // a constant false so the chevron/fade/reserved-padding never appear. It used
  // to measure scrollHeight vs clientHeight in a ResizeObserver, but the reserved
  // padding it toggled changed clientHeight, which re-flipped canExpand at the
  // refresh rate (a visible flicker). Measurement removed entirely.
  const canExpand = () => false

  const textPart = createMemo(
    () => props.parts?.find((p) => p.type === "text" && !(p as TextPart).synthetic) as TextPart | undefined,
  )

  const text = createMemo(() => textPart()?.text || "")

  const files = createMemo(() => (props.parts?.filter((p) => p.type === "file") as FilePart[]) ?? [])

  const attachments = createMemo(() =>
    files()?.filter((f) => {
      const mime = f.mime
      return mime.startsWith("image/") || mime === "application/pdf"
    }),
  )

  const inlineFiles = createMemo(() =>
    files().filter((f) => {
      const mime = f.mime
      return !mime.startsWith("image/") && mime !== "application/pdf" && f.source?.text?.start !== undefined
    }),
  )

  const agents = createMemo(() => (props.parts?.filter((p) => p.type === "agent") as AgentPart[]) ?? [])

  const openImagePreview = (url: string, alt?: string) => {
    dialog.show(() => <ImagePreview src={url} alt={alt} />)
  }

  const toggleExpanded = () => {
    if (!canExpand()) return
    setExpanded((value) => !value)
  }

  return (
    <div data-component="user-message" data-expanded={expanded()} data-can-expand={canExpand()}>
      <Show when={attachments().length > 0}>
        <div data-slot="user-message-attachments">
          <For each={attachments()}>
            {(file) => (
              <div
                data-slot="user-message-attachment"
                data-type={file.mime.startsWith("image/") ? "image" : "file"}
                onClick={() => {
                  if (file.mime.startsWith("image/") && file.url) {
                    openImagePreview(file.url, file.filename)
                  }
                }}
              >
                <Show
                  when={file.mime.startsWith("image/") && file.url}
                  fallback={
                    <div data-slot="user-message-attachment-icon">
                      <Icon name="folder" />
                    </div>
                  }
                >
                  <img
                    data-slot="user-message-attachment-image"
                    src={file.url}
                    alt={file.filename ?? i18n.t("ui.message.attachment.alt")}
                  />
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={text()}>
        <div data-slot="user-message-text" onClick={toggleExpanded}>
          <HighlightedText text={text()} references={inlineFiles()} agents={agents()} />
          <button
            data-slot="user-message-expand"
            type="button"
            aria-label={expanded() ? i18n.t("ui.message.collapse") : i18n.t("ui.message.expand")}
            onClick={(event) => {
              event.stopPropagation()
              toggleExpanded()
            }}
          >
            <Icon name="chevron-down" size="small" />
          </button>
        </div>
      </Show>
    </div>
  )
}

type HighlightSegment = { text: string; type?: "file" | "agent" }

function HighlightedText(props: { text: string; references: FilePart[]; agents: AgentPart[] }) {
  const segments = createMemo(() => {
    const text = props.text

    const allRefs: { start: number; end: number; type: "file" | "agent" }[] = [
      ...props.references
        .filter((r) => r.source?.text?.start !== undefined && r.source?.text?.end !== undefined)
        .map((r) => ({ start: r.source!.text!.start, end: r.source!.text!.end, type: "file" as const })),
      ...props.agents
        .filter((a) => a.source?.start !== undefined && a.source?.end !== undefined)
        .map((a) => ({ start: a.source!.start, end: a.source!.end, type: "agent" as const })),
    ].sort((a, b) => a.start - b.start)

    const result: HighlightSegment[] = []
    let lastIndex = 0

    for (const ref of allRefs) {
      if (ref.start < lastIndex) continue

      if (ref.start > lastIndex) {
        result.push({ text: text.slice(lastIndex, ref.start) })
      }

      result.push({ text: text.slice(ref.start, ref.end), type: ref.type })
      lastIndex = ref.end
    }

    if (lastIndex < text.length) {
      result.push({ text: text.slice(lastIndex) })
    }

    return result
  })

  return <For each={segments()}>{(segment) => <span data-highlight={segment.type}>{segment.text}</span>}</For>
}

export function Part(props: MessagePartProps) {
  const component = createMemo(() => PART_MAPPING[props.part.type])
  return (
    <Show when={component()}>
      <Dynamic
        component={component()}
        part={props.part}
        message={props.message}
        hideDetails={props.hideDetails}
        defaultOpen={props.defaultOpen}
        footer={props.footer}
      />
    </Show>
  )
}

export interface ToolProps {
  input: Record<string, any>
  metadata: Record<string, any>
  tool: string
  output?: string
  status?: string
  hideDetails?: boolean
  defaultOpen?: boolean
  forceOpen?: boolean
  locked?: boolean
}

export type ToolComponent = Component<ToolProps>

const state: Record<
  string,
  {
    name: string
    render?: ToolComponent
  }
> = {}

export function registerTool(input: { name: string; render?: ToolComponent }) {
  state[input.name] = input
  return input
}

export function getTool(name: string) {
  return state[name]?.render
}

export const ToolRegistry = {
  register: registerTool,
  render: getTool,
}

PART_MAPPING["tool"] = function ToolPartDisplay(props) {
  const data = useData()
  const i18n = useI18n()
  const part = props.part as ToolPart

  const permission = createMemo(() => {
    const next = data.store.permission?.[props.message.sessionID]?.[0]
    if (!next || !next.tool) return undefined
    if (next.tool!.callID !== part.callID) return undefined
    return next
  })

  const [showPermission, setShowPermission] = createSignal(false)

  createEffect(() => {
    const perm = permission()
    if (perm) {
      const timeout = setTimeout(() => setShowPermission(true), 50)
      onCleanup(() => clearTimeout(timeout))
    } else {
      setShowPermission(false)
    }
  })

  const [forceOpen, setForceOpen] = createSignal(false)
  createEffect(() => {
    if (permission()) setForceOpen(true)
  })

  const respond = (response: "once" | "always" | "reject") => {
    const perm = permission()
    if (!perm || !data.respondToPermission) return
    data.respondToPermission({
      sessionID: perm.sessionID,
      permissionID: perm.id,
      response,
    })
  }

  const emptyInput: Record<string, any> = {}
  const emptyMetadata: Record<string, any> = {}

  const input = () => part.state?.input ?? emptyInput
  // @ts-expect-error
  const partMetadata = () => part.state?.metadata ?? emptyMetadata
  const metadata = () => {
    const perm = permission()
    if (perm?.metadata) return { ...perm.metadata, ...partMetadata() }
    return partMetadata()
  }

  const render = ToolRegistry.render(part.tool) ?? GenericTool

  return (
    <div data-component="tool-part-wrapper" data-permission={showPermission()}>
      <BlockNumber sessionID={props.message.sessionID} id={part.id} />
      <Switch>
        <Match when={part.state.status === "error" && part.state.error}>
          {(error) => {
            const cleaned = error().replace("Error: ", "")
            const [title, ...rest] = cleaned.split(": ")
            return (
              <Card variant="error">
                <div data-component="tool-error">
                  <Icon name="circle-ban-sign" size="small" />
                  <Switch>
                    <Match when={title && title.length < 30}>
                      <div data-slot="message-part-tool-error-content">
                        <div data-slot="message-part-tool-error-title">{title}</div>
                        <span data-slot="message-part-tool-error-message">{rest.join(": ")}</span>
                      </div>
                    </Match>
                    <Match when={true}>
                      <span data-slot="message-part-tool-error-message">{cleaned}</span>
                    </Match>
                  </Switch>
                </div>
              </Card>
            )
          }}
        </Match>
        <Match when={true}>
          <Dynamic
            component={render}
            input={input()}
            tool={part.tool}
            metadata={metadata()}
            // @ts-expect-error
            output={part.state.output}
            status={part.state.status}
            hideDetails={props.hideDetails}
            forceOpen={forceOpen()}
            locked={showPermission()}
          />
        </Match>
      </Switch>
      <Show when={showPermission() && permission()}>
        <div data-component="permission-prompt">
          <div data-slot="permission-actions">
            <Button variant="ghost" size="small" onClick={() => respond("reject")}>
              {i18n.t("ui.permission.deny")}
            </Button>
            <Button variant="secondary" size="small" onClick={() => respond("always")}>
              {i18n.t("ui.permission.allowAlways")}
            </Button>
            <Button variant="primary" size="small" onClick={() => respond("once")}>
              {i18n.t("ui.permission.allowOnce")}
            </Button>
          </div>
        </div>
      </Show>
    </div>
  )
}

PART_MAPPING["text"] = function TextPartDisplay(props) {
  const data = useData()
  const part = props.part as TextPart
  const displayText = () => relativizeProjectPaths((part.text ?? "").trim(), data.directory)
  const throttledText = createThrottledValue(displayText)

  // Render an assistant text step in the same MessageBox as the turn's Response
  // box (◈ ASSISTANT header, #N, copy button). A text block that is the current
  // response and one that has demoted into the steps then look identical — only
  // the position changes — so the block keeps its identity across the transition.
  return (
    <Show when={throttledText()}>
      <MessageBox message={props.message} numberKey={part.id} copy={displayText}>
        <Markdown text={throttledText()} cacheKey={part.id} />
        {/* Snapshot line under every assistant text box, matching the Response
            box. Gate on this block's OWN completion, not the whole turn: an
            intermediate step gets its chips as soon as it finishes, while the
            still-streaming last block stays footer-less until it completes. */}
        <Show when={props.footer && (props.message as AssistantMessage).time.completed}>
          {props.footer!(props.message as AssistantMessage)}
        </Show>
      </MessageBox>
    </Show>
  )
}

PART_MAPPING["reasoning"] = function ReasoningPartDisplay(props) {
  const part = props.part as ReasoningPart
  const text = () => part.text.trim()
  const throttledText = createThrottledValue(text)

  return (
    <Show when={throttledText()}>
      <div data-component="reasoning-part">
        <Markdown text={throttledText()} cacheKey={part.id} />
      </div>
    </Show>
  )
}

ToolRegistry.register({
  name: "read",
  render(props) {
    const data = useData()
    const i18n = useI18n()
    const args: string[] = []
    const offset = props.input.offset ?? 0
    if (props.input.limit) args.push(`lines ${offset + 1}\u2013${offset + props.input.limit}`)
    else if (props.input.offset) args.push(`from line ${offset + 1}`)
    const loaded = createMemo(() => {
      if (props.status !== "completed") return []
      const value = props.metadata.loaded
      if (!value || !Array.isArray(value)) return []
      return value.filter((p): p is string => typeof p === "string")
    })
    return (
      <>
        <BasicTool
          {...props}
          icon="glasses"
          trigger={{
            title: i18n.t("ui.tool.read"),
            subtitle: props.input.filePath ? relativizeProjectPaths(props.input.filePath, data.directory) : "",
            args,
          }}
        />
        <For each={loaded()}>
          {(filepath) => (
            <div data-component="tool-loaded-file">
              <Icon name="enter" size="small" />
              <span>
                {i18n.t("ui.tool.loaded")} {relativizeProjectPaths(filepath, data.directory)}
              </span>
            </div>
          )}
        </For>
      </>
    )
  },
})

ToolRegistry.register({
  name: "list",
  render(props) {
    const i18n = useI18n()
    return (
      <BasicTool
        {...props}
        defaultOpen
        icon="bullet-list"
        trigger={{ title: i18n.t("ui.tool.list"), subtitle: getDirectory(props.input.path || "/") }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <Markdown text={`\`\`\`\n${output()}\n\`\`\``} complete />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "glob",
  render(props) {
    const i18n = useI18n()
    return (
      <BasicTool
        {...props}
        defaultOpen
        icon="magnifying-glass-menu"
        trigger={{
          title: i18n.t("ui.tool.glob"),
          subtitle: getDirectory(props.input.path || "/"),
          args: props.input.pattern ? ["pattern=" + props.input.pattern] : [],
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <Markdown text={`\`\`\`\n${output()}\n\`\`\``} complete />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "grep",
  render(props) {
    const i18n = useI18n()
    const args: string[] = []
    if (props.input.pattern) args.push("pattern=" + props.input.pattern)
    if (props.input.include) args.push("include=" + props.input.include)
    return (
      <BasicTool
        {...props}
        defaultOpen
        icon="magnifying-glass-menu"
        trigger={{
          title: i18n.t("ui.tool.grep"),
          subtitle: getDirectory(props.input.path || "/"),
          args,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <Markdown text={`\`\`\`\n${output()}\n\`\`\``} complete />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "webfetch",
  render(props) {
    const i18n = useI18n()
    return (
      <BasicTool
        {...props}
        icon="window-cursor"
        trigger={{
          title: i18n.t("ui.tool.webfetch"),
          subtitle: props.input.url || "",
          args: props.input.format ? ["format=" + props.input.format] : [],
          action: props.input.url ? (
            <a
              data-component="icon-button"
              data-size="normal"
              data-variant="secondary"
              data-slot="tool-action"
              href={props.input.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              <Icon name="square-arrow-top-right" size="small" />
            </a>
          ) : undefined,
        }}
      />
    )
  },
})

ToolRegistry.register({
  name: "websearch",
  render(props) {
    const i18n = useI18n()
    const args = () => {
      const out: string[] = []
      if (props.input.type) out.push("type=" + props.input.type)
      if (props.input.numResults) out.push("results=" + props.input.numResults)
      return out
    }
    return (
      <BasicTool
        {...props}
        icon="magnifying-glass"
        defaultOpen
        trigger={{
          title: i18n.t("ui.tool.websearch"),
          subtitle: props.input.query || "",
          args: args(),
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-slot="tool-body">
              <CopyButton content={() => output()} />
              <div data-component="tool-output" data-scrollable>
                <Markdown text={output()} complete />
              </div>
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "task",
  render(props) {
    const data = useData()
    const i18n = useI18n()
    const childSessionId = () => props.metadata.sessionId as string | undefined

    const childPermission = createMemo(() => {
      const sessionId = childSessionId()
      if (!sessionId) return undefined
      const permissions = data.store.permission?.[sessionId] ?? []
      return permissions[0]
    })

    const childToolPart = createMemo(() => {
      const perm = childPermission()
      if (!perm || !perm.tool) return undefined
      const sessionId = childSessionId()
      if (!sessionId) return undefined
      // Find the tool part that matches the permission's callID
      const messages = data.store.message[sessionId] ?? []
      const message = findLast(messages, (m) => m.id === perm.tool!.messageID)
      if (!message) return undefined
      const parts = data.store.part[message.id] ?? []
      for (const part of parts) {
        if (part.type === "tool" && (part as ToolPart).callID === perm.tool!.callID) {
          return { part: part as ToolPart, message }
        }
      }

      return undefined
    })

    const respond = (response: "once" | "always" | "reject") => {
      const perm = childPermission()
      if (!perm || !data.respondToPermission) return
      data.respondToPermission({
        sessionID: perm.sessionID,
        permissionID: perm.id,
        response,
      })
    }

    const handleSubtitleClick = () => {
      const sessionId = childSessionId()
      if (sessionId && data.navigateToSession) {
        data.navigateToSession(sessionId)
      }
    }

    // Dispatch fields as one markdown block so it themes like the rest of the
    // UI: bold labels, code pills for the agent/toolset/tool identifiers.
    const dispatchMarkdown = createMemo(() => {
      const lines: string[] = []
      const push = (label: string, value: string) => lines.push(`**${label}** ${value}`)
      if (props.input.description) push(i18n.t("ui.tool.task.label.task"), props.input.description)
      if (props.metadata.summary) push(i18n.t("ui.tool.task.label.summary"), props.metadata.summary as string)
      push(i18n.t("ui.tool.task.label.agent"), `\`${props.input.subagent_type || props.tool}\``)
      if (props.metadata.toolset) push(i18n.t("ui.tool.task.label.toolset"), `\`${props.metadata.toolset as string}\``)
      const tools = props.metadata.tools
      if (Array.isArray(tools) && tools.length)
        push(i18n.t("ui.tool.task.label.tools"), tools.map((t) => `\`${t}\``).join(" "))
      return lines.join("\n\n")
    })

    const renderChildToolPart = () => {
      const toolData = childToolPart()
      if (!toolData) return null
      const { part } = toolData
      const render = ToolRegistry.render(part.tool) ?? GenericTool
      // @ts-expect-error
      const metadata = part.state?.metadata ?? {}
      const input = part.state?.input ?? {}
      return (
        <Dynamic
          component={render}
          input={input}
          tool={part.tool}
          metadata={metadata}
          // @ts-expect-error
          output={part.state.output}
          status={part.state.status}
          defaultOpen={true}
        />
      )
    }

    return (
      <div data-component="tool-part-wrapper" data-permission={!!childPermission()}>
        <Switch>
          <Match when={childPermission()}>
            <>
              <Show
                when={childToolPart()}
                fallback={
                  <BasicTool
                    icon="task"
                    tool="task"
                    defaultOpen={true}
                    trigger={{
                      title: i18n.t("ui.tool.agent", { type: props.input.subagent_type || props.tool }),
                      titleClass: "capitalize",
                      subtitle: props.input.description,
                    }}
                    onSubtitleClick={handleSubtitleClick}
                  />
                }
              >
                {renderChildToolPart()}
              </Show>
              <div data-component="permission-prompt">
                <div data-slot="permission-actions">
                  <Button variant="ghost" size="small" onClick={() => respond("reject")}>
                    {i18n.t("ui.permission.deny")}
                  </Button>
                  <Button variant="secondary" size="small" onClick={() => respond("always")}>
                    {i18n.t("ui.permission.allowAlways")}
                  </Button>
                  <Button variant="primary" size="small" onClick={() => respond("once")}>
                    {i18n.t("ui.permission.allowOnce")}
                  </Button>
                </div>
              </div>
            </>
          </Match>
          <Match when={true}>
            <div
              data-component="task-output"
              class="accent-box"
              style={{
                "--box-accent": TASK_ACCENT,
                "--box-border": "var(--box-border-task)",
                "--box-bg": "var(--box-bg-task)",
                padding: "0.5rem 0.75rem",
              }}
            >
              <div
                data-slot="task-output-header"
                style={{
                  display: "flex",
                  "align-items": "center",
                  gap: "0.5rem",
                  "margin-bottom": "0.375rem",
                  color: TASK_ACCENT,
                  "font-size": "11px",
                  "font-weight": "600",
                  "letter-spacing": "0.04em",
                }}
              >
                <span>{"\u25c8"}</span>
                <span>TASK OUTPUT</span>
                <Show when={props.metadata.status === "async_launched"}>
                  <span data-slot="task-output-status">{i18n.t("ui.tool.task.dispatched")}</span>
                </Show>
              </div>
              <Switch>
                {/* A real inline result (rare/future sync path) wins. */}
                <Match when={props.output && stripTaskOutput(props.output)}>
                  {(body) => (
                    <div data-slot="tool-body">
                      <CopyButton content={() => body()} />
                      <div data-slot="task-output-body" data-component="tool-output" data-scrollable>
                        <Markdown text={body()} complete />
                      </div>
                    </div>
                  )}
                </Match>
                {/* Background dispatch: no inline result, so lay out what was
                    launched as labeled fields. The real result lands as a
                    separate TASK RESULT box below. */}
                <Match when={props.metadata.status === "async_launched"}>
                  <div data-slot="task-output-dispatch">
                    <Markdown text={dispatchMarkdown()} complete />
                  </div>
                </Match>
                {/* Args still streaming (prompt/description being written): show
                    a live counter instead of an empty box. */}
                <Match when={props.status === "pending"}>
                  <ToolStreaming label={i18n.t("ui.tool.task.preparing")} />
                </Match>
              </Switch>
            </div>
          </Match>
        </Switch>
      </div>
    )
  },
})

ToolRegistry.register({
  name: "skill",
  render(props) {
    const i18n = useI18n()
    // A skill call is its own block, so it gets its own box (header-only, no
    // body) like other content-less tools, instead of a bare inline line.
    return (
      <BasicTool
        {...props}
        icon="code-lines"
        trigger={{ title: i18n.t("ui.tool.skill"), subtitle: props.input.name ?? "" }}
      />
    )
  },
})

ToolRegistry.register({
  name: "bash",
  render(props) {
    const i18n = useI18n()
    const command = () => props.input.command ?? props.metadata.command ?? ""
    const output = () => props.output || props.metadata.output
    return (
      <BasicTool
        {...props}
        defaultOpen
        icon="console"
        trigger={{
          title: i18n.t("ui.tool.shell"),
          subtitle: props.input.description,
        }}
      >
        {/* Only render the body once the command has streamed in. While the
            call is still running with no command text yet, showing the fence
            would print a bare "$" with nothing after it (looks blank/broken). */}
        <Show when={command()}>
          <div data-component="tool-output" data-scrollable>
            <Markdown
              text={`\`\`\`command\n$ ${command()}${output() ? "\n\n" + stripAnsi(output()) : ""}\n\`\`\``}
              complete
            />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "edit",
  render(props) {
    const i18n = useI18n()
    const diffComponent = useDiffComponent()
    const diagnostics = createMemo(() => getDiagnostics(props.metadata.diagnostics, props.input.filePath))
    const filename = () => getFilename(props.input.filePath ?? "")
    return (
      <BasicTool
        {...props}
        defaultOpen
        icon="code-lines"
        trigger={
          <div data-component="edit-trigger">
            <div data-slot="message-part-title-area">
              <div data-slot="message-part-title">
                <span data-slot="message-part-title-text">{i18n.t("ui.messagePart.title.edit")}</span>
                <span data-slot="message-part-title-filename">{filename()}</span>
              </div>
              <Show when={props.input.filePath?.includes("/")}>
                <div data-slot="message-part-path">
                  <span data-slot="message-part-directory">{getDirectory(props.input.filePath!)}</span>
                </div>
              </Show>
            </div>
            <div data-slot="message-part-actions">
              <Show when={props.metadata.filediff}>
                <DiffChanges changes={props.metadata.filediff} />
              </Show>
            </div>
          </div>
        }
      >
        <Switch>
          <Match when={props.metadata.filediff?.path || props.input.newString || props.input.oldString}>
            <div data-component="edit-content">
              <Dynamic
                component={diffComponent}
                before={{
                  name: props.metadata?.filediff?.file || props.input.filePath,
                  contents: props.metadata?.filediff?.before || props.input.oldString,
                }}
                after={{
                  name: props.metadata?.filediff?.file || props.input.filePath,
                  contents: props.metadata?.filediff?.after || props.input.newString,
                }}
              />
            </div>
          </Match>
          {/* Args still streaming (old/new strings being written): show a live
              streaming bar instead of an empty box. */}
          <Match when={props.status === "pending"}>
            <ToolStreaming label={i18n.t("ui.tool.edit.preparing")} />
          </Match>
        </Switch>
        <DiagnosticsDisplay diagnostics={diagnostics()} />
      </BasicTool>
    )
  },
})

// Live "working" affordance shown while a tool call's arguments are still
// streaming (status === "pending", before the parsed input arrives). Replaces
// an empty/stuck box with a shimmering label + an indeterminate progress bar: a
// highlight band travels continuously across the track the whole time args
// stream. We can't know the total argument size mid-stream (and providers chunk
// tool input coarsely), so a proportional fill reads as "stuck" on small/chunky
// payloads. A traveling band always moves, so it always reads as active.
function ToolStreaming(props: { label: string }) {
  return (
    <div data-slot="tool-streaming">
      <TextShimmer class="tool-streaming-label">{props.label}</TextShimmer>
      <span data-slot="tool-streaming-bar" data-indeterminate>
        <span data-slot="tool-streaming-bar-fill" />
      </span>
    </div>
  )
}

ToolRegistry.register({
  name: "write",
  render(props) {
    const i18n = useI18n()
    const codeComponent = useCodeComponent()
    const diagnostics = createMemo(() => getDiagnostics(props.metadata.diagnostics, props.input.filePath))
    const filename = () => getFilename(props.input.filePath ?? "")
    return (
      <BasicTool
        {...props}
        defaultOpen
        icon="code-lines"
        trigger={
          <div data-component="write-trigger">
            <div data-slot="message-part-title-area">
              <div data-slot="message-part-title">
                <span data-slot="message-part-title-text">{i18n.t("ui.messagePart.title.write")}</span>
                <span data-slot="message-part-title-filename">{filename()}</span>
              </div>
              <Show when={props.input.filePath?.includes("/")}>
                <div data-slot="message-part-path">
                  <span data-slot="message-part-directory">{getDirectory(props.input.filePath!)}</span>
                </div>
              </Show>
            </div>
            <div data-slot="message-part-actions">{/* <DiffChanges diff={diff} /> */}</div>
          </div>
        }
      >
        <Switch>
          <Match when={props.input.content}>
            <div data-component="write-content">
              <Dynamic
                component={codeComponent}
                file={{
                  name: props.input.filePath,
                  contents: props.input.content,
                  cacheKey: checksum(props.input.content),
                }}
                overflow="scroll"
              />
            </div>
          </Match>
          {/* Args still streaming: show a live streaming bar instead of an empty box. */}
          <Match when={props.status === "pending"}>
            <ToolStreaming label={i18n.t("ui.tool.write.preparing")} />
          </Match>
        </Switch>
        <DiagnosticsDisplay diagnostics={diagnostics()} />
      </BasicTool>
    )
  },
})

interface ApplyPatchFile {
  filePath: string
  relativePath: string
  type: "add" | "update" | "delete" | "move"
  diff: string
  before: string
  after: string
  additions: number
  deletions: number
  movePath?: string
}

ToolRegistry.register({
  name: "apply_patch",
  render(props) {
    const i18n = useI18n()
    const diffComponent = useDiffComponent()
    const files = createMemo(() => (props.metadata.files ?? []) as ApplyPatchFile[])

    const subtitle = createMemo(() => {
      const count = files().length
      if (count === 0) return ""
      return `${count} ${i18n.t(count > 1 ? "ui.common.file.other" : "ui.common.file.one")}`
    })

    return (
      <BasicTool
        {...props}
        defaultOpen
        icon="code-lines"
        trigger={{
          title: i18n.t("ui.tool.patch"),
          subtitle: subtitle(),
        }}
      >
        <Switch>
          <Match when={files().length > 0}>
            <div data-component="apply-patch-files">
              <For each={files()}>
                {(file) => (
                  <div data-component="apply-patch-file">
                    <div data-slot="apply-patch-file-header">
                      <Switch>
                        <Match when={file.type === "delete"}>
                          <span data-slot="apply-patch-file-action" data-type="delete">
                            {i18n.t("ui.patch.action.deleted")}
                          </span>
                        </Match>
                        <Match when={file.type === "add"}>
                          <span data-slot="apply-patch-file-action" data-type="add">
                            {i18n.t("ui.patch.action.created")}
                          </span>
                        </Match>
                        <Match when={file.type === "move"}>
                          <span data-slot="apply-patch-file-action" data-type="move">
                            {i18n.t("ui.patch.action.moved")}
                          </span>
                        </Match>
                        <Match when={file.type === "update"}>
                          <span data-slot="apply-patch-file-action" data-type="update">
                            {i18n.t("ui.patch.action.patched")}
                          </span>
                        </Match>
                      </Switch>
                      <span data-slot="apply-patch-file-path">{file.relativePath}</span>
                      <Show when={file.type !== "delete"}>
                        <DiffChanges changes={{ additions: file.additions, deletions: file.deletions }} />
                      </Show>
                      <Show when={file.type === "delete"}>
                        <span data-slot="apply-patch-deletion-count">-{file.deletions}</span>
                      </Show>
                    </div>
                    <Show when={file.type !== "delete"}>
                      <div data-component="apply-patch-file-diff">
                        <Dynamic
                          component={diffComponent}
                          before={{ name: file.filePath, contents: file.before }}
                          after={{ name: file.filePath, contents: file.after }}
                        />
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Match>
          {/* Args still streaming (patchText being written): show a live
              streaming bar instead of an empty box. */}
          <Match when={props.status === "pending"}>
            <ToolStreaming label={i18n.t("ui.tool.patch.preparing")} />
          </Match>
        </Switch>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "todowrite",
  render(props) {
    const i18n = useI18n()
    const todos = createMemo(() => {
      const meta = props.metadata?.todos
      if (Array.isArray(meta)) return meta

      const input = props.input.todos
      if (Array.isArray(input)) return input

      return []
    })

    const subtitle = createMemo(() => {
      const list = todos()
      if (list.length === 0) return ""
      return `${list.filter((t: Todo) => t.status === "completed").length}/${list.length}`
    })

    const asMarkdown = () =>
      todos()
        .map((t: Todo) => `- [${t.status === "completed" ? "x" : " "}] ${t.content}`)
        .join("\n")

    return (
      <BasicTool
        {...props}
        defaultOpen
        icon="checklist"
        trigger={{
          title: i18n.t("ui.tool.todos"),
          subtitle: subtitle(),
        }}
      >
        <Show when={todos().length}>
          <div data-slot="tool-body">
            <CopyButton content={asMarkdown} />
            <div data-component="todos">
              <For each={todos()}>
                {(todo: Todo) => (
                  <Checkbox readOnly checked={todo.status === "completed"}>
                    <div data-slot="message-part-todo-content" data-completed={todo.status === "completed"}>
                      {todo.content}
                    </div>
                  </Checkbox>
                )}
              </For>
            </div>
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "question",
  render(props) {
    const i18n = useI18n()
    const questions = createMemo(() => (props.input.questions ?? []) as QuestionInfo[])
    const answers = createMemo(() => (props.metadata.answers ?? []) as QuestionAnswer[])
    const deferred = createMemo(() => props.metadata.deferred === true)
    const completed = createMemo(() => answers().length > 0)

    const DEFERRED_ANSWER = "__deferred__"
    const format = (answer: QuestionAnswer | undefined) => {
      if (!answer?.length) return i18n.t("ui.question.answer.none")
      if (answer.length === 1 && answer[0] === DEFERRED_ANSWER) return i18n.t("ui.question.answer.deferred")
      return answer.join(", ")
    }

    const subtitle = createMemo(() => {
      const count = questions().length
      if (count === 0) return ""
      if (deferred()) return i18n.t("ui.question.subtitle.deferred")
      if (completed()) return i18n.t("ui.question.subtitle.answered", { count })
      return `${count} ${i18n.t(count > 1 ? "ui.common.question.other" : "ui.common.question.one")}`
    })

    return (
      <BasicTool
        {...props}
        icon="bubble-5"
        trigger={{
          title: i18n.t("ui.tool.questions"),
          subtitle: subtitle(),
        }}
      >
        <Show when={completed()}>
          <div data-component="question-answers">
            <For each={questions()}>
              {(q, i) => {
                const answer = createMemo(() => answers()[i()])
                const picked = createMemo(() => {
                  const a = answer()
                  if (!a?.length) return []
                  if (a.length === 1 && a[0] === DEFERRED_ANSWER) return []
                  return a.map((label) => ({
                    label,
                    description: q.options.find((o) => o.label === label)?.description,
                  }))
                })
                return (
                  <div data-slot="question-answer-item">
                    <div data-slot="question-text">{q.question}</div>
                    <Show when={picked().length} fallback={<div data-slot="answer-text">{format(answer())}</div>}>
                      <For each={picked()}>
                        {(choice) => (
                          <div data-slot="answer-choice">
                            <div data-slot="answer-text">{choice.label}</div>
                            <Show when={choice.description}>
                              <div data-slot="answer-description">
                                <Markdown class="question-markdown" text={choice.description!} complete />
                              </div>
                            </Show>
                          </div>
                        )}
                      </For>
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </BasicTool>
    )
  },
})
