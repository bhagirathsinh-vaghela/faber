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
  CompactionPart,
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
import { legacyInternal, typed } from "../util/internal"
import { stripJobResult, stripSubagentMeta, stripSubagentResult } from "../util/envelope"
import { jobAccent, jobLabel } from "../util/job-status"
import { LaunchCard } from "../util/launch-card"
import { useData } from "../context"
import { useDiffComponent } from "../context/diff"
import { useDialog } from "../context/dialog"
import { Dialog } from "./dialog"
import { useI18n } from "../context/i18n"
import { TranscriptCard, type CardAccent } from "./transcript-card"
import { Collapsible } from "./collapsible"
import { TextShimmer } from "./text-shimmer"
import { Button } from "./button"
import { Icon } from "./icon"
import { IconButton } from "./icon-button"
import { Checkbox } from "./checkbox"
import { DiffChanges } from "./diff-changes"
import { Markdown, StreamingMarkdown } from "./markdown"
import { ImagePreview } from "./image-preview"
import { findLast } from "@opencode-ai/util/array"
import { getDirectory as _getDirectory, getFilename, truncateMiddle } from "@opencode-ai/util/path"
import { Tooltip } from "./tooltip"
import { CopyButton } from "./copy-button"
import { SpeakButton } from "./speak-button"
import { createBoxOpen, useBoxDefaults } from "../context/box-defaults"
import { messageTime } from "../util/time"

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
  // When set, the box header's identity (◈ #N ROLE time) becomes a button that
  // scrolls this message into view. Used by the sticky user-message header.
  onJump?: () => void
  // How discoverable the jump affordance is: "hover" (default) reveals the arrow
  // only on hover; "rest" keeps it faintly visible at rest.
  jumpHint?: "rest" | "hover"
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

function getDirectory(path: string | undefined) {
  return _getDirectory(path)
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
    case "agent":
      return {
        icon: "robot",
        title: i18n.t("ui.tool.agent", { type: input.subagent_type || "agent" }),
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

function subagentResultPart(parts: PartType[]): TextPart | undefined {
  return parts.find((p) => p.type === "text" && (p as TextPart).backgroundSubagentResult) as TextPart | undefined
}

// Navigate into a subagent's child session. Both the launch card and the result
// card open the same child, so the guard lives in one place: no-op unless both
// a target session and a navigator are present.
function navigateToChildSession(nav: ((sessionID: string) => void) | undefined, sessionID: string | undefined) {
  if (sessionID && nav) nav(sessionID)
}

// The result-box label per terminal status. A cancelled subagent must not read
// as "Done"; each status names itself.
const SUBAGENT_BOX_KEY = {
  failed: "ui.tool.subagent.box.failed",
  cancelled: "ui.tool.subagent.box.cancelled",
  completed: "ui.tool.subagent.box.done",
} as const
function subagentBoxKey(status: string) {
  return SUBAGENT_BOX_KEY[status as keyof typeof SUBAGENT_BOX_KEY] ?? SUBAGENT_BOX_KEY.completed
}

// Only for a call recorded before the agent tool wrote its card fields into
// metadata: such a part has nothing but its output text to render from.
function stripSubagentOutput(text: string): string {
  const cleaned = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<task_metadata>[\s\S]*?<\/task_metadata>/g, "")
    .trim()
  return stripSubagentMeta(cleaned)
}

// Ring-dot separator, same as the assistant footer chip line.
function SubagentDot() {
  return (
    <span
      class="mx-2 inline-block size-[4px] rounded-full border align-middle"
      style={{ "border-color": "var(--text-weaker)" }}
    />
  )
}

function subagentDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
}

// One card renderer for every injected user-message card (subagent result, job
// result, notice, compaction). It wraps TranscriptCard in the same tool-part-wrapper
// the live subagent LAUNCH card uses, so a result card is the SAME component and
// CSS as the launch card — identical header, typography, chevron and box chrome
// by construction, not by keeping two implementations in sync. `tokens` points
// the wrapper's tool colours at the card's accent (subagent amber, job blue,
// grey for system); `jump` is the optional scroll-to affordance in the sticky
// context.
function CardBox(props: {
  message: MessageType
  icon: IconProps["name"]
  title: string
  // Same three trigger slots the launch card uses, so a result card's header
  // reads with the identical spacing and separators, not a pre-joined string.
  subtitle?: string
  args?: string[]
  // The box-type key that drives the per-mode collapse default, matching the
  // settings row for this card (subagent_result / job_result / system_notice /
  // user / assistant).
  tool: string
  // The card's colour family, and an optional tone that overrides it when the
  // card's state is not plain success. The base derives border, fill and header
  // text from these, so a card names its colour once and cannot hold a partial
  // set.
  accent?: CardAccent
  tone?: string
  jump?: JSX.Element
  // A card that stays open: its header is still the same button every other card
  // has, it just cannot be collapsed, so no card type gets a header of a
  // different KIND. The assistant card is the only caller.
  locked?: boolean
  // Title-bar controls, threaded to TranscriptCard's actions cluster. copy/speak
  // are the assistant's; revert is the user's.
  copy?: () => string
  speak?: () => string
  revert?: JSX.Element
  // The block index key. Defaults to the message id; the assistant card passes
  // its part id so each text step numbers independently.
  numberKey?: string
  // The four injected cards nest their body in the launch card's padded dispatch
  // slot; user/assistant supply their own body chrome, so they opt out with raw.
  raw?: boolean
  // Marks a message-role card (user/assistant) so its header keeps that role's
  // own accent-coloured, 11px/600 styling instead of the neutral launch-card
  // header — see the data-role rules in message-part.css. Absent on tool cards.
  role?: "user" | "assistant"
  summaryOnly?: boolean
  children: JSX.Element
}) {
  const ctx = useData()
  return (
    <div data-component="tool-part-wrapper" data-role={props.role}>
      <TranscriptCard
        icon={props.icon}
        tool={props.tool}
        accent={props.accent}
        tone={props.tone}
        forceOpen={props.locked}
        locked={props.locked}
        blockNumber={ctx.blockNumber(props.message.sessionID, props.numberKey ?? props.message.id)}
        time={props.message.time.created}
        sessionID={props.message.sessionID}
        boxID={props.message.id}
        bare={props.raw}
        summaryOnly={props.summaryOnly}
        trigger={{ title: props.title, subtitle: props.subtitle, args: props.args }}
        jump={props.jump}
        copy={props.copy}
        speak={props.speak}
        revert={props.revert}
      >
        <Show when={props.raw} fallback={<div data-slot="subagent-output-dispatch">{props.children}</div>}>
          {props.children}
        </Show>
      </TranscriptCard>
    </div>
  )
}

// The undo control on a user card: a "Revert here" button that opens a confirm
// dialog before rolling the session back to this message. Its own component (not
// a TranscriptCard slot) because it owns the dialog + Enter-to-confirm lifecycle; the
// card only positions it. Absent when the host cannot revert.
function RevertButton(props: { message: MessageType }) {
  const host = useData()
  const dialog = useDialog()
  function confirm() {
    const doRevert = () => {
      dialog.close()
      host.revertMessage?.({ sessionID: props.message.sessionID, messageID: props.message.id })
    }
    // Kobalte owns dialog focus, so a document-level Enter listener for the
    // dialog's lifetime is more reliable than an element handler. Escape is
    // Kobalte's own.
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
  return (
    <Show when={host.revertMessage}>
      <div data-slot="message-box-revert">
        <Tooltip value="Cache-safe revert" placement="top" gutter={8}>
          <Button variant="secondary" onClick={confirm}>
            Revert here
          </Button>
        </Tooltip>
      </div>
    </Show>
  )
}

// A terminal status that is not plain success carries its own colour instead of
// the family's, so a failed card cannot read as a finished one. Success returns
// nothing, leaving the family accent in place.
function statusTone(status: string): string | undefined {
  if (status === "failed" || status === "timeout") return "var(--syntax-critical)"
  if (status === "cancelled" || status === "stopped" || status === "ended" || status === "running")
    return "var(--text-weak)"
  return undefined
}

// The scroll-to-this-message control the sticky header shows, or nothing when
// the card is not in a jump context. Sibling of the trigger (never nested). The
// `hint` drives the arrow's discoverability via data-jump-hint (see the
// message-box-identity CSS): "hover" hides it until hover/focus, "rest" keeps it
// faint; on a coarse pointer (hover: none) both reveal it persistently. Omitting
// the hint is what made the arrow always-on — it MUST be set.
function jumpAction(onJump?: () => void, hint: "rest" | "hover" = "hover"): JSX.Element | undefined {
  if (!onJump) return undefined
  return (
    <span
      data-slot="message-box-identity"
      data-jump="true"
      data-jump-hint={hint}
      role="button"
      tabindex={0}
      title="Scroll to this message"
      onClick={(event: MouseEvent) => {
        event.stopPropagation()
        onJump()
      }}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        event.stopPropagation()
        onJump()
      }}
    >
      <span data-slot="message-box-jump" aria-hidden="true">
        <Icon name="arrow-up" size="small" />
      </span>
    </span>
  )
}

// The footer chip line: agent name, the literal kind, status, and duration,
// each colored by its own semantic token.
function SubagentResultDisplay(props: { part: TextPart }) {
  const meta = () => props.part.backgroundSubagentResult!
  const i18n = useI18n()
  const ctx = useData()
  // The main session is a glanceable index: show only an EXCERPT of the result;
  // the full text lives in the child session, reached via the link below. Cap
  // to the first few lines so a large result never dumps into the main thread.
  const EXCERPT_LINES = 5
  const excerpt = createMemo(() => {
    const lines = stripSubagentResult(props.part.text).split("\n")
    return { text: lines.slice(0, EXCERPT_LINES).join("\n").trim(), truncated: lines.length > EXCERPT_LINES }
  })
  const openSession = () => navigateToChildSession(ctx.navigateToSession, meta().sessionID)
  return (
    <div data-component="subagent-result" data-scrollable>
      <Show when={excerpt().text}>
        <Markdown text={excerpt().text} cacheKey={props.part.id} />
      </Show>
      <Show when={meta().sessionID}>
        <Button
          variant="ghost"
          size="small"
          data-slot="subagent-result-open"
          onClick={(e: MouseEvent) => {
            e.stopPropagation()
            openSession()
          }}
        >
          {(excerpt().truncated ? "\u2026 " : "") + i18n.t("ui.tool.subagent.open")}
        </Button>
      </Show>
    </div>
  )
}

function jobResultPart(parts: PartType[]): TextPart | undefined {
  return parts.find((p) => p.type === "text" && (p as TextPart).backgroundJobResult) as TextPart | undefined
}

// The job card's fixed left-cluster title: the status label, then the exit code
// and duration when present. The (long, variable) command rides the flexible
// in-between arg, so it truncates there rather than blowing out this title.
function jobHeaderMeta(job: NonNullable<TextPart["backgroundJobResult"]>): string {
  const parts = [jobLabel(job.status)]
  if (job.exit !== undefined) parts.push(`exit ${job.exit}`)
  parts.push(subagentDuration(job.duration))
  return parts.join(" · ")
}

// A message the system wrote ON ITS OWN, which the reader needs told about:
// the supervisor's continue prompt after a restart is the one in practice. The
// user branch renders only non-synthetic text, so without its own branch such
// a message draws an empty box saying nothing about what happened.
//
// Machinery the model reads carries `internal`, so it is excluded by the flag
// the writer set rather than by sniffing its text for a marker. Debug mode
// drops that exclusion, which is the whole point of the mode.
//
// `legacyInternal` decides the same question for a part carrying no flag, and
// lives in its own module so every caller reaches one answer.

// A plain user message is worth a box only when it has something a reader can
// see: text the user actually typed (non-synthetic) or a file attachment. A
// message whose parts are all synthetic/internal machinery (e.g. the injected
// plan-mode-switch notice, which is excluded from the notice branch outside
// debug) would otherwise draw an empty box — the no-blank-box invariant. This
// guards the plain-user catch-all so such a message renders nothing at all.
function hasVisibleUserContent(parts: PartType[]): boolean {
  return parts.some(
    (p) => (p.type === "text" && !(p as TextPart).synthetic && (p as TextPart).text.trim()) || p.type === "file",
  )
}

function noticePart(parts: PartType[], showInternal = false): TextPart | undefined {
  if (subagentResultPart(parts) || jobResultPart(parts)) return undefined
  // A message the user typed into draws as their message, whatever synthetic
  // parts an attachment added beside it. This branch is for a message with no
  // typed text at all, which is the case the empty box was about.
  if (!showInternal && typed(parts)) return undefined
  const text = parts.find((p) => {
    if (p.type !== "text") return false
    const part = p as TextPart
    if (!part.synthetic) return false
    if (showInternal) return true
    return !part.internal && !legacyInternal(part)
  }) as TextPart | undefined
  return text?.text.trim() ? text : undefined
}

// The body as a single line, for a header that stands in for it while the card
// is closed. Newlines collapse to spaces so the text keeps running; how much of
// it fits is the row's business, not a character count's, so nothing is cut
// here. The header clips what it cannot show, at whatever width it has.
function noticeSummary(text: string): string {
  return text.trim().replace(/\s+/g, " ")
}

// Kobalte unmounts a closed Collapsible's content, so a collapsed card shows its
// header and nothing else. Without this the most-used card in the transcript —
// and the pinned prompt bar it also draws — collapses to "USER" and a timestamp,
// naming no turn. The header carries the summary the way a notice card does.
function userSummary(parts: PartType[]): string | undefined {
  const typed = parts.find((p) => p.type === "text" && !(p as TextPart).synthetic) as TextPart | undefined
  if (!typed?.text.trim()) return undefined
  return noticeSummary(typed.text)
}

// The summary line renders BEFORE the body and outside any scroller, so a
// collapsed box clipped to one line still shows it. A body that scrolls puts
// its first line inside the scroller, where the clip lands on empty space.
function NoticeDisplay(props: { part: TextPart }) {
  return (
    <div data-component="notice-result">
      <div data-component="notice-body" data-scrollable>
        <Markdown text={props.part.text} cacheKey={props.part.id} />
      </div>
    </div>
  )
}

function compactionPart(parts: PartType[]): CompactionPart | undefined {
  return parts.find((p) => p.type === "compaction") as CompactionPart | undefined
}

// The compaction request carries no text — its part is {type,auto} only — so
// without its own branch the user box renders empty. Reuses the notice box
// chrome (SYSTEM label, tool accent) so it reads like the supervisor's
// continue prompt, the other message the system writes on its own.
function CompactionDisplay(props: { part: CompactionPart }) {
  const i18n = useI18n()
  const text = createMemo(() =>
    props.part.auto ? i18n.t("ui.message.compaction.auto") : i18n.t("ui.message.compaction.manual"),
  )
  return (
    <div data-component="notice-result">
      <div data-component="notice-body" data-scrollable>
        <Markdown text={text()} cacheKey={props.part.id} />
      </div>
    </div>
  )
}

// A job's header answers what a reader asks of a finished command: what ran,
// how it ended, and how long it took. The command leads, because it is what
// identifies the block; the exit code follows the status, since a bare number
// means nothing without it.
function JobResultDisplay(props: { part: TextPart }) {
  const meta = () => props.part.backgroundJobResult!
  const content = createMemo(() => stripJobResult(props.part.text))
  // Body: the command as the first line (mono, WRAPS fully — the header only
  // shows it truncated in the in-between), then the output log. Status/exit/
  // duration live in the card header, so the body does not repeat them.
  return (
    <div data-component="job-result" data-scrollable>
      <div
        data-slot="job-result-command"
        class="mb-2 font-mono font-medium"
        style={{ color: "var(--syntax-type)", "font-size": "11px", "line-height": "1.4", "word-break": "break-all" }}
      >
        {"$ " + meta().command}
      </div>
      <Show when={content().trim()}>
        <Markdown text={content()} cacheKey={props.part.id} />
      </Show>
    </div>
  )
}

export function Message(props: MessageProps) {
  const boxDefaults = useBoxDefaults()
  const i18n = useI18n()
  const debugInternal = () => boxDefaults?.showInternal?.() ?? false
  return (
    <Switch>
      <Match when={props.message.role === "user" && subagentResultPart(props.parts)}>
        {(part) => (
          <Show when={props.boxed} fallback={<SubagentResultDisplay part={part()} />}>
            <CardBox
              message={props.message}
              icon="robot"
              title={i18n.t(subagentBoxKey(part().backgroundSubagentResult!.status), {
                label: LaunchCard.label(part().backgroundSubagentResult!.description),
                duration: subagentDuration(part().backgroundSubagentResult!.duration ?? 0),
              })}
              accent="subagent"
              tone={statusTone(part().backgroundSubagentResult!.status)}
              tool="subagent_result"
              jump={jumpAction(props.onJump, props.jumpHint)}
            >
              <SubagentResultDisplay part={part()} />
            </CardBox>
          </Show>
        )}
      </Match>
      <Match when={props.message.role === "user" && jobResultPart(props.parts)}>
        {(part) => (
          <Show when={props.boxed} fallback={<JobResultDisplay part={part()} />}>
            <CardBox
              message={props.message}
              icon="console"
              title={jobHeaderMeta(part().backgroundJobResult!)}
              args={[part().backgroundJobResult!.command]}
              summaryOnly
              accent="job"
              tone={statusTone(part().backgroundJobResult!.status)}
              tool="job_result"
              jump={jumpAction(props.onJump, props.jumpHint)}
            >
              <JobResultDisplay part={part()} />
            </CardBox>
          </Show>
        )}
      </Match>
      <Match when={props.message.role === "user" && noticePart(props.parts, debugInternal())}>
        {(part) => (
          <Show when={props.boxed} fallback={<NoticeDisplay part={part()} />}>
            <CardBox
              message={props.message}
              icon="bell"
              title={part().internal ? "INTERNAL" : "SYSTEM"}
              args={[noticeSummary(part().text)]}
              summaryOnly
              tool="system_notice"
              jump={jumpAction(props.onJump, props.jumpHint)}
            >
              <NoticeDisplay part={part()} />
            </CardBox>
          </Show>
        )}
      </Match>
      <Match when={props.message.role === "user" && compactionPart(props.parts)}>
        {(part) => (
          <Show when={props.boxed} fallback={<CompactionDisplay part={part()} />}>
            <CardBox
              message={props.message}
              icon="bell"
              title={i18n.t("ui.compaction.title")}
              args={[i18n.t("ui.compaction.reason")]}
              tool="system_notice"
              jump={jumpAction(props.onJump, props.jumpHint)}
            >
              <CompactionDisplay part={part()} />
            </CardBox>
          </Show>
        )}
      </Match>
      <Match when={props.message.role === "user" && hasVisibleUserContent(props.parts) && props.message}>
        {(userMessage) => (
          <Show
            when={props.boxed}
            fallback={<UserMessageDisplay message={userMessage() as UserMessage} parts={props.parts} />}
          >
            <CardBox
              message={userMessage() as UserMessage}
              icon="user"
              title="USER"
              subtitle={userSummary(props.parts)}
              summaryOnly
              tool="user"
              role="user"
              accent="user"
              raw
              jump={jumpAction(props.onJump, props.jumpHint)}
              revert={<RevertButton message={userMessage() as UserMessage} />}
              copy={() =>
                (props.parts.find((p) => p.type === "text" && !(p as TextPart).synthetic) as TextPart | undefined)
                  ?.text ?? ""
              }
            >
              <UserMessageDisplay message={userMessage() as UserMessage} parts={props.parts} />
            </CardBox>
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

  return (
    <div data-component="user-message">
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
        <div data-slot="user-message-text">
          <HighlightedText text={text()} references={inlineFiles()} agents={agents()} />
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
  // Server-supplied display label (MCP `annotations.title`). Absent for tools
  // whose server advertises none, so callers fall back to the tool id.
  title?: string
  output?: string
  status?: string
  hideDetails?: boolean
  defaultOpen?: boolean
  forceOpen?: boolean
  locked?: boolean
  // The box's sequential index, shown inline in the header row. Threaded to
  // TranscriptCard via {...props} so every tool renderer carries it without change.
  blockNumber?: number
  // The box's timestamp (ms), threaded the same way so every tool card shows it
  // between the icon and title.
  time?: number
  // Identity of this box's manual expand/collapse, threaded the same way.
  sessionID?: string
  boxID?: string
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

// Per-VALUE cap, not a cap on how many args are shown: every argument is part
// of what identifies the call, so dropping some makes two different calls look
// identical. Long values are what actually break the row, so each is truncated
// individually and the header wraps.
const GENERIC_ARG_MAX = 80

function genericArg(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  if (text === undefined) return undefined
  return truncateMiddle(text.replace(/\s+/g, " ").trim(), GENERIC_ARG_MAX)
}

// Fallback for every tool with no registered renderer — MCP and plugin tools.
// Their names are opaque, so the call is unreadable without its arguments: all
// of them go inline in the header, the full input and output into the body.
// Box-typed as "mcp" rather than the tool id so one settings row governs the
// collapse default for all of them instead of one row per discovered tool.
function GenericTool(props: ToolProps) {
  const args = createMemo(() =>
    Object.entries(props.input).flatMap(([key, value]) => {
      const formatted = genericArg(value)
      return formatted ? [`${key}=${formatted}`] : []
    }),
  )

  const body = createMemo(() => {
    const sections: string[] = []
    if (Object.keys(props.input).length) sections.push("```json\n" + JSON.stringify(props.input, null, 2) + "\n```")
    if (props.output) sections.push("```\n" + stripAnsi(props.output) + "\n```")
    return sections.join("\n\n")
  })

  return (
    <TranscriptCard
      {...props}
      icon="mcp"
      tool="mcp"
      trigger={{ title: props.title || props.tool, subtitle: props.title ? props.tool : undefined, args: args() }}
    >
      <Show when={body()}>
        <div data-component="tool-output" data-scrollable>
          <Markdown text={body()} complete />
        </div>
      </Show>
    </TranscriptCard>
  )
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
      <Switch>
        {/* A failed call is the SAME card as a successful one, wearing the error
            accent — a tool must not change shape between its two outcomes. */}
        <Match when={part.state.status === "error" && part.state.error}>
          {(error) => {
            const cleaned = () => error().replace(/^Error: /, "")
            const head = () => cleaned().split(": ")[0]
            const titled = () => head().length < 30
            return (
              <TranscriptCard
                icon="circle-ban-sign"
                tool={part.tool}
                blockNumber={data.blockNumber(props.message.sessionID, part.id)}
                time={props.message.time.created}
                sessionID={props.message.sessionID}
                boxID={part.id}
                bare
                tone="var(--icon-critical-base)"
                trigger={{
                  title: part.tool,
                  subtitle: titled() ? head() : undefined,
                }}
                copy={cleaned}
              >
                <span data-slot="message-part-tool-error-message">
                  {titled() ? cleaned().slice(head().length + 2) : cleaned()}
                </span>
              </TranscriptCard>
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
            title={part.state.title}
            // @ts-expect-error
            output={part.state.output}
            status={part.state.status}
            hideDetails={props.hideDetails}
            forceOpen={forceOpen()}
            locked={showPermission()}
            blockNumber={data.blockNumber(props.message.sessionID, part.id)}
            time={props.message.time.created}
            sessionID={props.message.sessionID}
            boxID={part.id}
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
  const part = props.part as TextPart
  const displayText = () => (part.text ?? "").trim()
  const throttledText = createThrottledValue(displayText)

  // Render an assistant text step as an ASSISTANT card (#N header, copy + speak).
  // A text block that is the current response and one that has demoted into the
  // steps then look identical — only the position changes — so the block keeps
  // its identity across the transition.
  return (
    <Show when={throttledText()}>
      <CardBox
        message={props.message}
        icon="assistant"
        title="ASSISTANT"
        tool="assistant"
        role="assistant"
        accent="assistant"
        locked
        raw
        numberKey={part.id}
        copy={displayText}
        speak={displayText}
      >
        <StreamingMarkdown text={throttledText()} cacheKey={part.id} complete={!!part.time?.end} />
        {/* Snapshot line under every assistant text box, matching the Response
            box. Gate on this block's OWN completion, not the whole turn: an
            intermediate step gets its chips as soon as it finishes, while the
            still-streaming last block stays footer-less until it completes. The
            footer sits in its own slot so the markdown flow's line leading and
            block margins cannot bleed into the gap above it; the spacing is owned
            by data-slot="assistant-footer" in message-part.css. */}
        <Show when={props.footer && (props.message as AssistantMessage).time.completed}>
          <div data-slot="assistant-footer">{props.footer!(props.message as AssistantMessage)}</div>
        </Show>
      </CardBox>
    </Show>
  )
}

PART_MAPPING["reasoning"] = function ReasoningPartDisplay(props) {
  const i18n = useI18n()
  const part = props.part as ReasoningPart
  const text = () => part.text.trim()
  const throttledText = createThrottledValue(text)

  return (
    <Show when={throttledText()}>
      <CardBox
        message={props.message}
        icon="brain"
        title={i18n.t("ui.reasoning.title")}
        subtitle={noticeSummary(throttledText())}
        summaryOnly
        tool="reasoning"
        accent="thinking"
        numberKey={part.id}
        raw
        copy={throttledText}
      >
        <StreamingMarkdown text={throttledText()} cacheKey={part.id} complete={!!part.time?.end} />
      </CardBox>
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
        <TranscriptCard
          {...props}
          icon="glasses"
          trigger={{
            title: i18n.t("ui.tool.read"),
            subtitle: props.title ?? props.input.filePath ?? "",
            args,
          }}
        />
        <For each={loaded()}>
          {(filepath) => (
            <div data-component="tool-loaded-file">
              <Icon name="enter" size="small" />
              <span>
                {i18n.t("ui.tool.loaded")} {filepath}
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
      <TranscriptCard
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
      </TranscriptCard>
    )
  },
})

ToolRegistry.register({
  name: "glob",
  render(props) {
    const i18n = useI18n()
    return (
      <TranscriptCard
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
      </TranscriptCard>
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
      <TranscriptCard
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
      </TranscriptCard>
    )
  },
})

ToolRegistry.register({
  name: "webfetch",
  render(props) {
    const i18n = useI18n()
    return (
      <TranscriptCard
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
      <TranscriptCard
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
      </TranscriptCard>
    )
  },
})

ToolRegistry.register({
  name: "agent",
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

    // Rendered in the trigger's action slot (a SIBLING of the trigger button,
    // never nested inside it — invalid HTML / a11y).
    const jumpToChild = () => navigateToChildSession(data.navigateToSession, childSessionId())

    const openButton = () =>
      childSessionId() ? (
        <IconButton
          icon="square-arrow-top-right"
          iconSize="small"
          variant="secondary"
          data-slot="tool-action"
          title={i18n.t("ui.tool.subagent.open")}
          onClick={(e) => {
            e.stopPropagation()
            jumpToChild()
          }}
        />
      ) : undefined

    // A call that recorded `mode` also recorded every field its card shows;
    // an older part without it has only its input to rebuild them from.
    const launch = createMemo(
      (): LaunchCard.Launch =>
        props.metadata.mode
          ? (props.metadata as LaunchCard.Launch)
          : {
              description: props.input.description,
              summary: props.metadata.summary as string | undefined,
              subagentType: props.input.subagent_type || props.tool,
              includeContext: props.input.include_context,
              toolset: props.metadata.toolset as string | undefined,
              tools: props.metadata.tools as string[] | undefined,
            },
    )

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
          title={part.state.title}
          // @ts-expect-error
          output={part.state.output}
          status={part.state.status}
          defaultOpen={true}
        />
      )
    }

    // The subagent box is a tool box wearing the subagent amber. The tokens ride
    // on the card itself; wrapping it to carry them would nest a box in a box.
    const accent = (): CardAccent | undefined => (childPermission() ? undefined : "subagent")

    return (
      <>
        <Switch>
          {/* A permission raised INSIDE the child session groups the card and its
              prompt into one blocking unit: the ring, the sticky pin and the
              prompt's seam all key on this wrapper. The outer wrapper cannot
              serve, since it tracks the PARENT session's permissions. */}
          <Match when={childPermission()}>
            <div data-component="tool-part-wrapper" data-permission="true">
              <Show
                when={childToolPart()}
                fallback={
                  <TranscriptCard
                    icon="robot"
                    tool="agent"
                    time={props.time}
                    blockNumber={props.blockNumber}
                    defaultOpen={true}
                    accent={accent()}
                    trigger={{
                      title: i18n.t("ui.tool.agent", { type: props.input.subagent_type || props.tool }),
                      subtitle: props.input.description,
                      action: openButton(),
                    }}
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
            </div>
          </Match>
          <Match when={true}>
            <TranscriptCard
              icon="robot"
              tool="agent"
              time={props.time}
              blockNumber={props.blockNumber}
              sessionID={props.sessionID}
              boxID={props.boxID}
              accent={accent()}
              summaryOnly
              trigger={{
                title:
                  props.metadata.status === "async_launched"
                    ? LaunchCard.title(i18n.t, launch())
                    : i18n.t("ui.tool.subagent.box.title"),
                subtitle:
                  props.metadata.status !== "async_launched"
                    ? LaunchCard.label(props.input.description ?? "")
                    : undefined,
                action: openButton(),
              }}
            >
              <Switch>
                <Match when={props.metadata.mode}>
                  <div data-slot="subagent-output-dispatch">
                    <Markdown text={LaunchCard.fields(i18n.t, launch())} complete />
                  </div>
                </Match>
                {/* A real inline result (rare/future sync path) wins. */}
                <Match when={props.output && stripSubagentOutput(props.output)}>
                  {(body) => (
                    <div data-slot="tool-body">
                      <CopyButton content={() => body()} />
                      <div data-slot="subagent-output-body" data-component="tool-output" data-scrollable>
                        <Markdown text={body()} complete />
                      </div>
                    </div>
                  )}
                </Match>
                {/* Background dispatch: no inline result, so lay out what was
                      launched as labeled fields. The real result lands as a
                      separate result box below. */}
                <Match when={props.metadata.status === "async_launched"}>
                  <div data-slot="subagent-output-dispatch">
                    <Markdown text={LaunchCard.fields(i18n.t, launch())} complete />
                  </div>
                </Match>
                {/* Args still streaming (prompt/description being written): show
                      a live counter instead of an empty box. */}
                <Match when={props.status === "pending"}>
                  <ToolStreaming label={i18n.t("ui.tool.subagent.preparing")} />
                </Match>
              </Switch>
            </TranscriptCard>
          </Match>
        </Switch>
      </>
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
      <TranscriptCard
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
      <TranscriptCard
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
      </TranscriptCard>
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
      <TranscriptCard
        {...props}
        defaultOpen
        icon="code-lines"
        trigger={{
          title: i18n.t("ui.messagePart.title.edit"),
          subtitle: filename(),
          args: props.input.filePath?.includes("/") ? [getDirectory(props.input.filePath)] : undefined,
          action: props.metadata.filediff ? <DiffChanges changes={props.metadata.filediff} /> : undefined,
        }}
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
      </TranscriptCard>
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
    const diffComponent = useDiffComponent()
    const diagnostics = createMemo(() => getDiagnostics(props.metadata.diagnostics, props.input.filePath))
    const filename = () => getFilename(props.input.filePath ?? "")
    return (
      <TranscriptCard
        {...props}
        defaultOpen
        icon="code-lines"
        trigger={{
          title: i18n.t("ui.messagePart.title.write"),
          subtitle: filename(),
          args: props.input.filePath?.includes("/") ? [getDirectory(props.input.filePath)] : undefined,
        }}
      >
        <Switch>
          <Match when={props.input.content}>
            <div data-component="write-content">
              <Dynamic
                component={diffComponent}
                before={{ name: props.input.filePath, contents: "" }}
                after={{ name: props.input.filePath, contents: props.input.content }}
              />
            </div>
          </Match>
          {/* Args still streaming: show a live streaming bar instead of an empty box. */}
          <Match when={props.status === "pending"}>
            <ToolStreaming label={i18n.t("ui.tool.write.preparing")} />
          </Match>
        </Switch>
        <DiagnosticsDisplay diagnostics={diagnostics()} />
      </TranscriptCard>
    )
  },
})

interface ApplyPatchFile {
  filePath: string
  targetPath: string
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
      <TranscriptCard
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
                      <span data-slot="apply-patch-file-path">{file.targetPath}</span>
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
      </TranscriptCard>
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
      <TranscriptCard
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
      </TranscriptCard>
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
      <TranscriptCard
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
      </TranscriptCard>
    )
  },
})
