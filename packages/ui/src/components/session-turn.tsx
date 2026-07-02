import {
  AssistantMessage,
  FilePart,
  Message as MessageType,
  Part as PartType,
  type PermissionRequest,
  type QuestionRequest,
  TextPart,
  ToolPart,
} from "@opencode-ai/sdk/v2/client"
import { type FileDiff } from "@opencode-ai/sdk/v2"
import { useData } from "../context"
import { useDiffComponent } from "../context/diff"
import { type UiI18nKey, type UiI18nParams, useI18n } from "../context/i18n"
import { findLast } from "@opencode-ai/util/array"
import { getDirectory, getFilename } from "@opencode-ai/util/path"

import { Binary } from "@opencode-ai/util/binary"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  Match,
  on,
  onCleanup,
  ParentProps,
  Show,
  Switch,
} from "solid-js"
import { DiffChanges } from "./diff-changes"
import { Message, Part } from "./message-part"
import { Accordion } from "./accordion"
import { StickyAccordionHeader } from "./sticky-accordion-header"
import { FileIcon } from "./file-icon"
import { Icon } from "./icon"
import { Card } from "./card"
import { Dynamic } from "solid-js/web"
import { Button } from "./button"
import { Spinner } from "./spinner"
import { createStore } from "solid-js/store"
import { DateTime, DurationUnit, Interval } from "luxon"
import { createAutoScroll } from "../hooks"
import { createResizeObserver } from "@solid-primitives/resize-observer"

type Translator = (key: UiI18nKey, params?: UiI18nParams) => string

function computeStatusFromPart(part: PartType | undefined, t: Translator): string | undefined {
  if (!part) return undefined

  if (part.type === "tool") {
    switch (part.tool) {
      case "task":
        return t("ui.sessionTurn.status.delegating")
      case "todowrite":
      case "todoread":
        return t("ui.sessionTurn.status.planning")
      case "read":
        return t("ui.sessionTurn.status.gatheringContext")
      case "list":
      case "grep":
      case "glob":
        return t("ui.sessionTurn.status.searchingCodebase")
      case "webfetch":
        return t("ui.sessionTurn.status.searchingWeb")
      case "edit":
      case "write":
        return t("ui.sessionTurn.status.makingEdits")
      case "bash":
        return t("ui.sessionTurn.status.runningCommands")
      default:
        return undefined
    }
  }
  if (part.type === "reasoning") {
    const text = part.text ?? ""
    const match = text.trimStart().match(/^\*\*(.+?)\*\*/)
    if (match) return t("ui.sessionTurn.status.thinkingWithTopic", { topic: match[1].trim() })
    return t("ui.sessionTurn.status.thinking")
  }
  if (part.type === "text") {
    return t("ui.sessionTurn.status.gatheringThoughts")
  }
  return undefined
}

function same<T>(a: readonly T[], b: readonly T[]) {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

function isAttachment(part: PartType | undefined) {
  if (part?.type !== "file") return false
  const mime = (part as FilePart).mime ?? ""
  return mime.startsWith("image/") || mime === "application/pdf"
}

function AssistantMessageItem(props: {
  message: AssistantMessage
  responsePartId: string | undefined
  hideReasoning: boolean
  footer?: (message: AssistantMessage) => JSX.Element
}) {
  const data = useData()
  const emptyParts: PartType[] = []
  const msgParts = createMemo(() => data.store.part[props.message.id] ?? emptyParts)

  // Parts render inline in arrival order. The turn's current last text part is
  // pulled out and rendered as its own block below the steps box, so hide it
  // here (by id) to avoid rendering it twice. When a newer step arrives this
  // part is no longer the response, so it un-hides and takes its inline slot.
  const filteredParts = createMemo(() => {
    let parts = msgParts()
    if (props.hideReasoning) parts = parts.filter((part) => part?.type !== "reasoning")
    if (props.responsePartId) parts = parts.filter((part) => part?.id !== props.responsePartId)
    return parts
  })

  return <Message message={props.message} parts={filteredParts()} defaultOpen footer={props.footer} />
}

export function SessionTurn(
  props: ParentProps<{
    sessionID: string
    sessionTitle?: string
    messageID: string
    lastUserMessageID?: string
    stepsExpanded?: boolean
    onStepsExpandedToggle?: () => void
    onUserInteracted?: () => void
    footer?: (message: AssistantMessage) => JSX.Element
    classes?: {
      root?: string
      content?: string
      container?: string
    }
  }>,
) {
  const i18n = useI18n()
  const data = useData()
  const diffComponent = useDiffComponent()

  const emptyMessages: MessageType[] = []
  const emptyParts: PartType[] = []
  const emptyFiles: FilePart[] = []
  const emptyAssistant: AssistantMessage[] = []
  const emptyPermissions: PermissionRequest[] = []
  const emptyPermissionParts: { part: ToolPart; message: AssistantMessage }[] = []
  const emptyQuestions: QuestionRequest[] = []
  const emptyQuestionParts: { part: ToolPart; message: AssistantMessage }[] = []
  const emptyDiffs: FileDiff[] = []
  const idle = { type: "idle" as const }

  const allMessages = createMemo(() => data.store.message[props.sessionID] ?? emptyMessages)

  const messageIndex = createMemo(() => {
    const messages = allMessages() ?? emptyMessages
    const result = Binary.search(messages, props.messageID, (m) => m.id)

    const index = result.found ? result.index : messages.findIndex((m) => m.id === props.messageID)
    if (index < 0) return -1

    const msg = messages[index]
    if (!msg || msg.role !== "user") return -1

    return index
  })

  const message = createMemo(() => {
    const index = messageIndex()
    if (index < 0) return undefined

    const messages = allMessages() ?? emptyMessages
    const msg = messages[index]
    if (!msg || msg.role !== "user") return undefined

    return msg
  })

  const lastUserMessageID = createMemo(() => {
    if (props.lastUserMessageID) return props.lastUserMessageID

    const messages = allMessages() ?? emptyMessages
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg?.role === "user") return msg.id
    }
    return undefined
  })

  const isLastUserMessage = createMemo(() => props.messageID === lastUserMessageID())

  const parts = createMemo(() => {
    const msg = message()
    if (!msg) return emptyParts
    return data.store.part[msg.id] ?? emptyParts
  })

  const attachmentParts = createMemo(() => {
    const msgParts = parts()
    if (msgParts.length === 0) return emptyFiles
    return msgParts.filter((part) => isAttachment(part)) as FilePart[]
  })

  const stickyParts = createMemo(() => {
    const msgParts = parts()
    if (msgParts.length === 0) return emptyParts
    if (attachmentParts().length === 0) return msgParts
    return msgParts.filter((part) => !isAttachment(part))
  })

  const assistantMessages = createMemo(
    () => {
      const msg = message()
      if (!msg) return emptyAssistant

      const messages = allMessages() ?? emptyMessages
      const index = messageIndex()
      if (index < 0) return emptyAssistant

      const result: AssistantMessage[] = []
      for (let i = index + 1; i < messages.length; i++) {
        const item = messages[i]
        if (!item) continue
        if (item.role === "user") break
        if (item.role === "assistant" && item.parentID === msg.id) result.push(item as AssistantMessage)
      }
      return result
    },
    emptyAssistant,
    { equals: same },
  )

  const lastAssistantMessage = createMemo(() => assistantMessages().at(-1))

  const error = createMemo(() => assistantMessages().find((m) => m.error)?.error)

  // Promote only when the turn's VERY LAST visible block is an assistant text
  // block (its answer). If it ended on a tool — interrupted or otherwise — the
  // last block is not text, so nothing promotes and everything stays inline.
  const lastBlock = createMemo(() => {
    const msgs = assistantMessages()
    for (let mi = msgs.length - 1; mi >= 0; mi--) {
      const msgParts = data.store.part[msgs[mi].id] ?? emptyParts
      for (let pi = msgParts.length - 1; pi >= 0; pi--) {
        const part = msgParts[pi]
        if (part?.type === "text" || part?.type === "tool")
          return part.type === "text" ? { part: part as TextPart, message: msgs[mi] } : undefined
      }
    }
    return undefined
  })
  const lastTextPart = createMemo(() => lastBlock()?.part)
  const responsePartId = createMemo(() => lastBlock()?.part.id)

  const hasSteps = createMemo(() => {
    for (const m of assistantMessages()) {
      const msgParts = data.store.part[m.id]
      if (!msgParts) continue
      for (const p of msgParts) {
        if (p?.type === "tool") return true
      }
    }
    return false
  })

  const permissions = createMemo(() => data.store.permission?.[props.sessionID] ?? emptyPermissions)
  const permissionCount = createMemo(() => permissions().length)
  const nextPermission = createMemo(() => permissions()[0])

  const permissionParts = createMemo(() => {
    if (props.stepsExpanded) return emptyPermissionParts

    const next = nextPermission()
    if (!next || !next.tool) return emptyPermissionParts

    const message = findLast(assistantMessages(), (m) => m.id === next.tool!.messageID)
    if (!message) return emptyPermissionParts

    const parts = data.store.part[message.id] ?? emptyParts
    for (const part of parts) {
      if (part?.type !== "tool") continue
      const tool = part as ToolPart
      if (tool.callID === next.tool?.callID) return [{ part: tool, message }]
    }

    return emptyPermissionParts
  })

  const questions = createMemo(() => data.store.question?.[props.sessionID] ?? emptyQuestions)
  const nextQuestion = createMemo(() => questions()[0])

  const questionParts = createMemo(() => {
    if (props.stepsExpanded) return emptyQuestionParts

    const next = nextQuestion()
    if (!next || !next.tool) return emptyQuestionParts

    const message = findLast(assistantMessages(), (m) => m.id === next.tool!.messageID)
    if (!message) return emptyQuestionParts

    const parts = data.store.part[message.id] ?? emptyParts
    for (const part of parts) {
      if (part?.type !== "tool") continue
      const tool = part as ToolPart
      if (tool.callID === next.tool?.callID) return [{ part: tool, message }]
    }

    return emptyQuestionParts
  })

  const answeredQuestionParts = createMemo(() => {
    if (props.stepsExpanded) return emptyQuestionParts
    if (questions().length > 0) return emptyQuestionParts

    const result: { part: ToolPart; message: AssistantMessage }[] = []

    for (const msg of assistantMessages()) {
      const parts = data.store.part[msg.id] ?? emptyParts
      for (const part of parts) {
        if (part?.type !== "tool") continue
        const tool = part as ToolPart
        if (tool.tool !== "question") continue
        // @ts-expect-error metadata may not exist on all tool states
        const answers = tool.state?.metadata?.answers
        if (answers && answers.length > 0) {
          result.push({ part: tool, message: msg })
        }
      }
    }

    return result
  })

  const shellModePart = createMemo(() => {
    const p = parts()
    if (p.length === 0) return
    if (!p.every((part) => part?.type === "text" && part?.synthetic)) return

    const msgs = assistantMessages()
    if (msgs.length !== 1) return

    const msgParts = data.store.part[msgs[0].id] ?? emptyParts
    if (msgParts.length !== 1) return

    const assistantPart = msgParts[0]
    if (assistantPart?.type === "tool" && assistantPart.tool === "bash") return assistantPart
  })

  const isShellMode = createMemo(() => !!shellModePart())

  const rawStatus = createMemo(() => {
    const msgs = assistantMessages()
    let last: PartType | undefined
    let currentTask: ToolPart | undefined

    for (let mi = msgs.length - 1; mi >= 0; mi--) {
      const msgParts = data.store.part[msgs[mi].id] ?? emptyParts
      for (let pi = msgParts.length - 1; pi >= 0; pi--) {
        const part = msgParts[pi]
        if (!part) continue
        if (!last) last = part

        if (
          part.type === "tool" &&
          part.tool === "task" &&
          part.state &&
          "metadata" in part.state &&
          part.state.metadata?.sessionId &&
          part.state.status === "running"
        ) {
          currentTask = part as ToolPart
          break
        }
      }
      if (currentTask) break
    }

    const taskSessionId =
      currentTask?.state && "metadata" in currentTask.state
        ? (currentTask.state.metadata?.sessionId as string | undefined)
        : undefined

    if (taskSessionId) {
      const taskMessages = data.store.message[taskSessionId] ?? emptyMessages
      for (let mi = taskMessages.length - 1; mi >= 0; mi--) {
        const msg = taskMessages[mi]
        if (!msg || msg.role !== "assistant") continue

        const msgParts = data.store.part[msg.id] ?? emptyParts
        for (let pi = msgParts.length - 1; pi >= 0; pi--) {
          const part = msgParts[pi]
          if (part) return computeStatusFromPart(part, i18n.t)
        }
      }
    }

    return computeStatusFromPart(last, i18n.t)
  })

  const status = createMemo(() => data.store.session_status[props.sessionID] ?? idle)
  const working = createMemo(() => status().type !== "idle" && isLastUserMessage())
  const retry = createMemo(() => {
    // session_status is session-scoped; only show retry on the active (last) turn
    if (!isLastUserMessage()) return
    const s = status()
    if (s.type !== "retry") return
    return s
  })

  const response = createMemo(() => lastTextPart()?.text)
  const messageDiffs = createMemo(() => message()?.summary?.diffs ?? emptyDiffs)
  const hasDiffs = createMemo(() => messageDiffs().length > 0)

  const [rootRef, setRootRef] = createSignal<HTMLDivElement | undefined>()
  const [stickyRef, setStickyRef] = createSignal<HTMLDivElement | undefined>()
  // "stuck" = the sticky user message is pinned to the top because the transcript
  // has been scrolled past it. While stuck we collapse it to a one-line bar (see
  // session-turn.css); a chevron re-expands it as an absolute overlay that does
  // not shift the surrounding layout or scroll position.
  const [stuck, setStuck] = createSignal(false)
  const [stuckExpanded, setStuckExpanded] = createSignal(false)
  // Suppress the collapse while the turn is streaming: auto-scroll churns the
  // layout, so the sticky observer flips stuck on/off and the bar flickers
  // between one-line and full. Only collapse once the turn is idle.
  const collapsed = createMemo(() => stuck() && !working())

  const updateStickyHeight = (height: number) => {
    const root = rootRef()
    if (!root) return
    const next = Math.ceil(height)
    root.style.setProperty("--session-turn-sticky-height", `${next}px`)
  }

  function duration() {
    const msg = message()
    if (!msg) return ""
    const completed = lastAssistantMessage()?.time.completed
    const from = DateTime.fromMillis(msg.time.created)
    const to = completed ? DateTime.fromMillis(completed) : DateTime.now()
    const interval = Interval.fromDateTimes(from, to)
    const unit: DurationUnit[] = interval.length("seconds") > 60 ? ["minutes", "seconds"] : ["seconds"]

    const locale = i18n.locale()
    const human = interval.toDuration(unit).normalize().reconfigure({ locale }).toHuman({
      notation: "compact",
      unitDisplay: "narrow",
      compactDisplay: "short",
      showZeros: false,
    })
    return locale.startsWith("zh") ? human.replaceAll("、", "") : human
  }

  const autoScroll = createAutoScroll({
    working,
    onUserInteracted: props.onUserInteracted,
    overflowAnchor: "auto",
  })

  createResizeObserver(
    () => stickyRef(),
    ({ height }) => {
      updateStickyHeight(height)
    },
  )

  createEffect(() => {
    const root = rootRef()
    if (!root) return
    const sticky = stickyRef()
    if (!sticky) {
      root.style.setProperty("--session-turn-sticky-height", "0px")
      return
    }
    updateStickyHeight(sticky.getBoundingClientRect().height)
  })

  // Detect the "stuck" state with the canonical sticky-observer technique
  // (tobyzerner/sticky-observer, jakeisonline): observe the sticky element
  // itself with threshold [1] and a negative rootMargin equal to its sticky
  // offset. When it pins, IntersectionObserver reports it as no longer fully
  // intersecting -> stuck. Non-sticky sides get 100% so their edges never trip
  // the threshold. Observing the element directly (not a separate sentinel) is
  // what makes this fire reliably in BOTH scroll directions.
  // Nearest scrollable ancestor — the sticky element sticks relative to THIS,
  // not the viewport, so the IntersectionObserver must use it as root or the
  // rootMargin offset won't line up with where the element actually pins.
  const scrollRoot = (el: HTMLElement): Element | null => {
    let node = el.parentElement
    while (node) {
      const oy = getComputedStyle(node).overflowY
      if ((oy === "auto" || oy === "scroll") && node.scrollHeight > node.clientHeight) return node
      node = node.parentElement
    }
    return null
  }

  createEffect(() => {
    const el = stickyRef()
    if (!el) return

    const titleHeight = () => {
      const raw = getComputedStyle(el).getPropertyValue("--session-title-height").trim()
      return raw.endsWith("px") ? parseFloat(raw) || 0 : 0
    }

    const observe = () => {
      // Top sticks at titleHeight; +1px absorbs sub-pixel rounding. Other sides
      // use 100% so only the top edge crossing flips stuck. root is the scroll
      // container so the offset is measured where the element actually pins.
      const observer = new IntersectionObserver((entries) => setStuck(!entries[entries.length - 1].isIntersecting), {
        threshold: [1],
        rootMargin: `-${titleHeight() + 1}px 100% 100% 100%`,
        root: scrollRoot(el),
      })
      observer.observe(el)
      return observer
    }

    let observer = observe()
    // Rebuild when the title bar height changes so the top offset stays correct.
    const resize = new ResizeObserver(() => {
      observer.disconnect()
      observer = observe()
    })
    resize.observe(el)

    onCleanup(() => {
      observer.disconnect()
      resize.disconnect()
    })
  })

  // Collapsing the pinned bar is a scroll-driven artifact; reset the manual
  // overlay-expand whenever it unsticks so it never lingers open in flow.
  createEffect(() => {
    if (!collapsed()) setStuckExpanded(false)
  })

  // The expanded overlay is a transient peek: close it the moment the transcript
  // scrolls, so it can never linger open (and always re-collapses when the bar is
  // scrolled past again). Scroll events don't bubble but do fire in the capture
  // phase, so a document-level capturing listener catches whichever ancestor
  // scrolls without coupling this reusable component to the app's scroller class.
  createEffect(() => {
    if (!stuckExpanded()) return
    const close = () => setStuckExpanded(false)
    document.addEventListener("scroll", close, { capture: true, passive: true })
    onCleanup(() => document.removeEventListener("scroll", close, { capture: true }))
  })

  const diffInit = 20
  const diffBatch = 20

  const [store, setStore] = createStore({
    retrySeconds: 0,
    // The changed-files section is collapsed to a single header line by default;
    // the chevron expands it to reveal the file list.
    diffsSectionOpen: false,
    diffsOpen: [] as string[],
    diffLimit: diffInit,
    status: rawStatus(),
    duration: duration(),
  })

  createEffect(
    on(
      () => message()?.id,
      () => {
        setStore("diffsSectionOpen", false)
        setStore("diffsOpen", [])
        setStore("diffLimit", diffInit)
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    const r = retry()
    if (!r) {
      setStore("retrySeconds", 0)
      return
    }
    const updateSeconds = () => {
      const next = r.next
      if (next) setStore("retrySeconds", Math.max(0, Math.round((next - Date.now()) / 1000)))
    }
    updateSeconds()
    const timer = setInterval(updateSeconds, 1000)
    onCleanup(() => clearInterval(timer))
  })

  createEffect(() => {
    const update = () => {
      setStore("duration", duration())
    }

    update()

    // Only keep ticking while the active (in-progress) turn is running.
    if (!working()) return

    const timer = setInterval(update, 1000)
    onCleanup(() => clearInterval(timer))
  })

  createEffect(
    on(permissionCount, (count, prev) => {
      if (!count) return
      if (prev !== undefined && count <= prev) return
      autoScroll.forceScrollToBottom()
    }),
  )

  let lastStatusChange = Date.now()
  let statusTimeout: number | undefined
  createEffect(() => {
    const newStatus = rawStatus()
    if (newStatus === store.status || !newStatus) return

    const timeSinceLastChange = Date.now() - lastStatusChange
    if (timeSinceLastChange >= 2500) {
      setStore("status", newStatus)
      lastStatusChange = Date.now()
      if (statusTimeout) {
        clearTimeout(statusTimeout)
        statusTimeout = undefined
      }
    } else {
      if (statusTimeout) clearTimeout(statusTimeout)
      statusTimeout = setTimeout(() => {
        setStore("status", rawStatus())
        lastStatusChange = Date.now()
        statusTimeout = undefined
      }, 2500 - timeSinceLastChange) as unknown as number
    }
  })

  onCleanup(() => {
    if (!statusTimeout) return
    clearTimeout(statusTimeout)
  })

  return (
    <div data-component="session-turn" class={props.classes?.root} ref={setRootRef}>
      <div
        ref={autoScroll.scrollRef}
        onScroll={autoScroll.handleScroll}
        data-slot="session-turn-content"
        class={props.classes?.content}
      >
        <div onClick={autoScroll.handleInteraction}>
          <Show when={message()}>
            {(msg) => (
              <div
                ref={autoScroll.contentRef}
                data-message={msg().id}
                data-slot="session-turn-message-container"
                class={props.classes?.container}
              >
                <Switch>
                  <Match when={isShellMode()}>
                    <Part part={shellModePart()!} message={msg()} defaultOpen />
                  </Match>
                  <Match when={true}>
                    <Show when={attachmentParts().length > 0}>
                      <div data-slot="session-turn-attachments" aria-live="off">
                        <Message message={msg()} parts={attachmentParts()} />
                      </div>
                    </Show>
                    <div
                      data-slot="session-turn-sticky"
                      data-stuck={collapsed() ? "true" : undefined}
                      data-stuck-expanded={collapsed() && stuckExpanded() ? "true" : undefined}
                      ref={setStickyRef}
                    >
                      {/* User Message */}
                      <div
                        data-slot="session-turn-message-content"
                        aria-live="off"
                        onClick={(event) => {
                          // While pinned, the whole one-liner toggles the overlay.
                          // Ignore clicks on interactive children (revert/copy/etc)
                          // and when the user is selecting text.
                          if (!collapsed()) return
                          if ((event.target as HTMLElement).closest("button,a,[role='button']")) return
                          if (window.getSelection()?.toString()) return
                          setStuckExpanded((v) => !v)
                        }}
                      >
                        <Message message={msg()} parts={stickyParts()} boxed />
                        {/* Collapse/expand affordance shown only while pinned. */}
                        <button
                          data-slot="session-turn-sticky-expand"
                          type="button"
                          aria-label={stuckExpanded() ? i18n.t("ui.message.collapse") : i18n.t("ui.message.expand")}
                          aria-expanded={stuckExpanded()}
                          onClick={(event) => {
                            event.stopPropagation()
                            setStuckExpanded((v) => !v)
                          }}
                        >
                          <Icon name="chevron-grabber-vertical" size="small" />
                        </button>
                      </div>

                      {/* Trigger (sticky) */}
                      <Show when={working() || hasSteps()}>
                        <div data-slot="session-turn-response-trigger">
                          <Button
                            data-expandable={assistantMessages().length > 0}
                            data-slot="session-turn-collapsible-trigger-content"
                            variant="ghost"
                            size="small"
                            onClick={props.onStepsExpandedToggle ?? (() => {})}
                            aria-expanded={props.stepsExpanded}
                          >
                            <Switch>
                              <Match when={working()}>
                                <Spinner />
                              </Match>
                              <Match when={!props.stepsExpanded}>
                                <svg
                                  width="10"
                                  height="10"
                                  viewBox="0 0 10 10"
                                  fill="none"
                                  xmlns="http://www.w3.org/2000/svg"
                                  data-slot="session-turn-trigger-icon"
                                >
                                  <path
                                    d="M8.125 1.875H1.875L5 8.125L8.125 1.875Z"
                                    fill="currentColor"
                                    stroke="currentColor"
                                    stroke-linejoin="round"
                                  />
                                </svg>
                              </Match>
                              <Match when={props.stepsExpanded}>
                                <svg
                                  width="10"
                                  height="10"
                                  viewBox="0 0 10 10"
                                  fill="none"
                                  xmlns="http://www.w3.org/2000/svg"
                                  class="text-icon-base"
                                >
                                  <path
                                    d="M8.125 8.125H1.875L5 1.875L8.125 8.125Z"
                                    fill="currentColor"
                                    stroke="currentColor"
                                    stroke-linejoin="round"
                                  />
                                </svg>
                              </Match>
                            </Switch>
                            <Switch>
                              <Match when={retry()}>
                                <span data-slot="session-turn-retry-message">
                                  {(() => {
                                    const r = retry()
                                    if (!r) return ""
                                    return r.message.length > 60 ? r.message.slice(0, 60) + "..." : r.message
                                  })()}
                                </span>
                                <span data-slot="session-turn-retry-seconds">
                                  · {i18n.t("ui.sessionTurn.retry.retrying")}
                                  {store.retrySeconds > 0
                                    ? " " + i18n.t("ui.sessionTurn.retry.inSeconds", { seconds: store.retrySeconds })
                                    : ""}
                                </span>
                                <span data-slot="session-turn-retry-attempt">(#{retry()?.attempt})</span>
                              </Match>
                              <Match when={working()}>
                                <span data-slot="session-turn-status-text">
                                  {store.status ?? i18n.t("ui.sessionTurn.status.consideringNextSteps")}
                                </span>
                              </Match>
                              <Match when={props.stepsExpanded}>
                                <span data-slot="session-turn-status-text">{i18n.t("ui.sessionTurn.steps.hide")}</span>
                              </Match>
                              <Match when={!props.stepsExpanded}>
                                <span data-slot="session-turn-status-text">{i18n.t("ui.sessionTurn.steps.show")}</span>
                              </Match>
                            </Switch>
                            <span aria-hidden="true">·</span>
                            <span aria-live="off">{store.duration}</span>
                          </Button>
                        </div>
                      </Show>
                    </div>
                    {/* Response */}
                    <Show when={props.stepsExpanded && assistantMessages().length > 0}>
                      <div data-slot="session-turn-collapsible-content-inner" aria-hidden={working()}>
                        <For each={assistantMessages()}>
                          {(assistantMessage) => (
                            <AssistantMessageItem
                              message={assistantMessage}
                              responsePartId={working() ? undefined : responsePartId()}
                              hideReasoning={!working()}
                              footer={!working() ? props.footer : undefined}
                            />
                          )}
                        </For>
                        <Show when={error()}>
                          <Card variant="error" class="error-card">
                            {error()?.data?.message as string}
                          </Card>
                        </Show>
                      </div>
                    </Show>
                    {/* Once the turn is idle, promote its final block to its own
                        box below the steps — but only when that block is assistant
                        text (the answer). If the turn ended on a tool, lastBlock is
                        undefined and nothing promotes. While streaming everything
                        stays inline as a step, so nothing teleports mid-turn. */}
                    <Show when={!working() && lastBlock()}>
                      {(last) => (
                        <div data-slot="session-turn-promoted" style={{ width: "100%" }}>
                          <Part part={last().part} message={last().message} footer={props.footer} defaultOpen />
                        </div>
                      )}
                    </Show>
                    <Show when={!props.stepsExpanded && permissionParts().length > 0}>
                      <div data-slot="session-turn-permission-parts">
                        <For each={permissionParts()}>
                          {({ part, message }) => <Part part={part} message={message} />}
                        </For>
                      </div>
                    </Show>
                    <Show when={!props.stepsExpanded && questionParts().length > 0}>
                      <div data-slot="session-turn-question-parts">
                        <For each={questionParts()}>
                          {({ part, message }) => <Part part={part} message={message} />}
                        </For>
                      </div>
                    </Show>
                    <Show when={!props.stepsExpanded && answeredQuestionParts().length > 0}>
                      <div data-slot="session-turn-answered-question-parts">
                        <For each={answeredQuestionParts()}>
                          {({ part, message }) => <Part part={part} message={message} />}
                        </For>
                      </div>
                    </Show>
                    {/* Response text renders inline in the steps above, in
                        arrival order. This bottom section is now the changed-files
                        summary only, and exists in the DOM only when there ARE
                        diffs — no reserved space when the turn changed nothing. */}
                    <div class="sr-only" aria-live="polite">
                      {!working() && response() ? response() : ""}
                    </div>
                    <Show when={hasDiffs()}>
                      <div data-slot="session-turn-summary-section">
                        <button
                          type="button"
                          data-slot="session-turn-summary-header"
                          data-open={store.diffsSectionOpen}
                          aria-expanded={store.diffsSectionOpen}
                          onClick={() => setStore("diffsSectionOpen", (open) => !open)}
                        >
                          <Icon name="chevron-down" size="small" data-slot="session-turn-summary-chevron" />
                          <h2 data-slot="session-turn-summary-title">
                            {i18n.t("ui.sessionTurn.summary.changedFiles")}
                          </h2>
                          <span data-slot="session-turn-summary-count">{messageDiffs().length}</span>
                        </button>
                        <Show when={store.diffsSectionOpen}>
                          <Accordion
                            data-slot="session-turn-accordion"
                            multiple
                            value={store.diffsOpen}
                            onChange={(value) => {
                              if (!Array.isArray(value)) return
                              setStore("diffsOpen", value)
                            }}
                          >
                            <For each={messageDiffs().slice(0, store.diffLimit)}>
                              {(diff) => (
                                <Accordion.Item value={diff.file}>
                                  <StickyAccordionHeader>
                                    <Accordion.Trigger>
                                      <div data-slot="session-turn-accordion-trigger-content">
                                        <div data-slot="session-turn-file-info">
                                          <FileIcon
                                            node={{ path: diff.file, type: "file" }}
                                            data-slot="session-turn-file-icon"
                                          />
                                          <div data-slot="session-turn-file-path">
                                            <Show when={diff.file.includes("/")}>
                                              <span data-slot="session-turn-directory">
                                                {`\u202A${getDirectory(diff.file)}\u202C`}
                                              </span>
                                            </Show>
                                            <span data-slot="session-turn-filename">{getFilename(diff.file)}</span>
                                          </div>
                                        </div>
                                        <div data-slot="session-turn-accordion-actions">
                                          <DiffChanges changes={diff} />
                                          <Icon name="chevron-grabber-vertical" size="small" />
                                        </div>
                                      </div>
                                    </Accordion.Trigger>
                                  </StickyAccordionHeader>
                                  <Accordion.Content data-slot="session-turn-accordion-content">
                                    <Show when={store.diffsOpen.includes(diff.file!)}>
                                      <Dynamic
                                        component={diffComponent}
                                        before={{
                                          name: diff.file!,
                                          contents: diff.before!,
                                        }}
                                        after={{
                                          name: diff.file!,
                                          contents: diff.after!,
                                        }}
                                      />
                                    </Show>
                                  </Accordion.Content>
                                </Accordion.Item>
                              )}
                            </For>
                          </Accordion>
                          <Show when={messageDiffs().length > store.diffLimit}>
                            <Button
                              data-slot="session-turn-accordion-more"
                              variant="ghost"
                              size="small"
                              onClick={() => {
                                const total = messageDiffs().length
                                setStore("diffLimit", (limit) => {
                                  const next = limit + diffBatch
                                  if (next > total) return total
                                  return next
                                })
                              }}
                            >
                              {i18n.t("ui.sessionTurn.diff.showMore", {
                                count: messageDiffs().length - store.diffLimit,
                              })}
                            </Button>
                          </Show>
                        </Show>
                      </div>
                    </Show>
                    <Show when={error() && !props.stepsExpanded}>
                      <Card variant="error" class="error-card">
                        {error()?.data?.message as string}
                      </Card>
                    </Show>
                  </Match>
                </Switch>
              </div>
            )}
          </Show>
          {props.children}
        </div>
      </div>
    </div>
  )
}
