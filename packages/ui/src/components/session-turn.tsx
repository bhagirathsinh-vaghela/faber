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
import { createBoxOpen, useBoxDefaults } from "../context/box-defaults"
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
import { busyBase, busyDelay, busyOverlays, busyShown } from "../util/busy-tint"
import { Accordion } from "./accordion"
import { StickyAccordionHeader } from "./sticky-accordion-header"
import { FileIcon } from "./file-icon"
import { Icon } from "./icon"
import { Card } from "./card"
import { Dynamic } from "solid-js/web"
import { Button } from "./button"
import { Spinner } from "./spinner"
import { createStore } from "solid-js/store"
import { createResizeObserver } from "@solid-primitives/resize-observer"

type Translator = (key: UiI18nKey, params?: UiI18nParams) => string

function computeStatusFromPart(part: PartType | undefined, t: Translator): string | undefined {
  if (!part) return undefined

  if (part.type === "tool") {
    switch (part.tool) {
      case "agent":
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
        return t("ui.sessionTurn.status.callingTool", { tool: part.tool })
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
  footer?: (message: AssistantMessage) => JSX.Element
}) {
  const data = useData()
  const emptyParts: PartType[] = []
  const parts = createMemo(() => data.store.part[props.message.id] ?? emptyParts)

  return <Message message={props.message} parts={parts()} defaultOpen footer={props.footer} />
}

export function SessionTurn(
  props: ParentProps<{
    sessionID: string
    sessionTitle?: string
    messageID: string
    lastUserMessageID?: string
    stepsExpanded?: boolean
    onStepsExpandedToggle?: () => void
    onJump?: () => void
    // Discoverability of the sticky header's jump affordance; forwarded to
    // Message ("hover" reveal-on-hover by default, "rest" for faint-at-rest).
    jumpHint?: "rest" | "hover"
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
          part.tool === "agent" &&
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
  // Busy boolean from the one operative store (effective: own turn OR subtree).
  // Only the active (last) turn shows the spinner. session_status is used ONLY
  // for the retry label below, never for the busy boolean.
  const busyFacts = createMemo(
    () => data.store.session_busy[props.sessionID] ?? { busy: false, busySelf: false, busyDescendant: false },
  )
  const busy = createMemo(() => busyShown(busyFacts()))
  const working = createMemo(() => busy() && isLastUserMessage())
  // No agent color in the ui context, so an own turn keeps the inherited
  // currentColor rather than resolving a tint of its own.
  const spinnerTint = createMemo(() => (busyFacts().busySelf ? undefined : busyBase(busyFacts(), undefined)))
  const overlays = createMemo(() => busyOverlays(busyFacts(), undefined))
  const retry = createMemo(() => {
    // session_status is session-scoped; only show retry on the active (last) turn
    if (!isLastUserMessage()) return
    const s = status()
    if (s.type !== "retry") return
    return s
  })

  const response = createMemo(() => lastTextPart()?.text)
  // Stats tier (file, additions, deletions) rides the message summary; bodies
  // are stripped server-side and lazy-fetched when the section opens. Old
  // messages persisted with inline bodies render from them directly.
  const [fetchedDiffs, setFetchedDiffs] = createSignal<FileDiff[] | undefined>()
  const messageDiffs = createMemo(() => {
    const stats = message()?.summary?.diffs ?? emptyDiffs
    const bodies = fetchedDiffs()
    if (!bodies) return stats
    return stats.map((d) => {
      if (typeof d.before === "string" || typeof d.after === "string") return d
      const full = bodies.find((b) => b.file === d.file)
      return full ? { ...d, before: full.before, after: full.after } : d
    })
  })
  const hasDiffs = createMemo(() => messageDiffs().length > 0)
  let diffFetchFor: string | undefined
  function loadDiffBodies() {
    const info = message()
    if (!info || diffFetchFor === info.id) return
    const missing = (info.summary?.diffs ?? emptyDiffs).some(
      (d) => typeof d.before !== "string" && typeof d.after !== "string",
    )
    if (!missing) return
    diffFetchFor = info.id
    data
      .fetchMessageDiff?.({ sessionID: props.sessionID, messageID: info.id })
      .then((diffs) => {
        if (diffs) setFetchedDiffs(diffs)
      })
      .catch(() => {
        diffFetchFor = undefined
      })
  }

  const [rootRef, setRootRef] = createSignal<HTMLDivElement | undefined>()
  const [stickyRef, setStickyRef] = createSignal<HTMLDivElement | undefined>()
  const boxDefaults = useBoxDefaults()

  const updateStickyHeight = (height: number) => {
    const root = rootRef()
    if (!root) return
    const next = Math.ceil(height)
    root.style.setProperty("--session-turn-sticky-height", `${next}px`)
  }

  // Elapsed turn time, formatted to match luxon's narrow compact output the
  // full pipeline (Interval -> toDuration -> normalize -> toHuman) produced
  // before: "45s" at or under a minute, "3m, 20s" past it, the seconds part
  // dropped when zero ("60m"). Runs once a second while a turn is live, so the
  // luxon build and the dead zh-locale branch were per-tick waste for the en
  // case; a couple of divisions replace them.
  function duration() {
    const msg = message()
    if (!msg) return ""
    const completed = lastAssistantMessage()?.time.completed
    const seconds = Math.floor(((completed ?? Date.now()) - msg.time.created) / 1000)
    if (seconds <= 0) return ""
    if (seconds <= 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    const rest = seconds % 60
    return rest === 0 ? `${minutes}m` : `${minutes}m, ${rest}s`
  }

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

  const diffInit = 20
  const diffBatch = 20

  // The changed-files section is collapsed to a single header line by default;
  // the chevron expands it to reveal the file list.
  const [diffsSectionOpen, setDiffsSectionOpen] = createBoxOpen({
    sessionID: () => props.sessionID,
    boxID: () => `${props.messageID}:diffs`,
    fallback: () => false,
  })

  // Each file is toggled independently, so the array the accordion wants is
  // projected from per-file entries rather than held as one value.
  const diffFileID = (file: string) => `${props.messageID}:diff:${file}`
  const [localDiffsOpen, setLocalDiffsOpen] = createSignal<string[]>([])
  // Diffs stream in mid-turn; without the content check the accordion remounts
  // on each arrival and drops what the user had open.
  const emptyOpen: string[] = []
  const diffsOpen = createMemo(
    () => {
      if (!boxDefaults) return localDiffsOpen()
      return messageDiffs().flatMap((diff) =>
        boxDefaults.open(props.sessionID, diffFileID(diff.file)) ? [diff.file] : [],
      )
    },
    emptyOpen,
    { equals: same },
  )
  const setDiffsOpen = (next: string[]) => {
    if (!boxDefaults) {
      setLocalDiffsOpen(next)
      return
    }
    const before = diffsOpen()
    for (const file of [...next, ...before]) {
      const open = next.includes(file)
      if (open === before.includes(file)) continue
      boxDefaults.setOpen(props.sessionID, diffFileID(file), open)
    }
  }

  const [store, setStore] = createStore({
    retrySeconds: 0,
    diffLimit: diffInit,
    status: rawStatus(),
    duration: duration(),
  })

  createEffect(
    on(
      () => message()?.id,
      () => {
        setStore("diffLimit", diffInit)
        setFetchedDiffs(undefined)
        diffFetchFor = undefined
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
      <div data-slot="session-turn-content" class={props.classes?.content}>
        <div>
          <Show when={message()}>
            {(msg) => (
              <div data-message={msg().id} data-slot="session-turn-message-container" class={props.classes?.container}>
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
                    <div data-slot="session-turn-sticky" ref={setStickyRef}>
                      <div data-slot="session-turn-sticky-fade" aria-hidden="true" />
                      {/* User Message */}
                      <div data-slot="session-turn-message-content" aria-live="off">
                        <Message
                          message={msg()}
                          parts={stickyParts()}
                          boxed
                          onJump={props.onJump}
                          jumpHint={props.jumpHint}
                        />
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
                                <span style={{ position: "relative", display: "inline-flex" }}>
                                  <Spinner style={{ color: spinnerTint() }} />
                                  <For each={overlays()}>
                                    {(tint, index) => (
                                      <Spinner
                                        style={{
                                          position: "absolute",
                                          inset: 0,
                                          color: tint,
                                          animation: "dock-task-fade 2.6s ease-in-out infinite",
                                          "animation-delay": busyDelay(index(), overlays().length),
                                        }}
                                      />
                                    )}
                                  </For>
                                </span>
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
                    {/* Response. The answer part has ONE lifelong mount point per
                        turn, keyed by part.id, so a busy-rollup edge cannot remount
                        it mid-stream. Which mount point is chosen by stepsExpanded
                        (stable, user-driven) never by working() (flickers on
                        subtree/job rollups). Expanded shows every step inline;
                        collapsed shows just the final text block as a peek. */}
                    <Show when={props.stepsExpanded && assistantMessages().length > 0}>
                      <div data-slot="session-turn-collapsible-content-inner">
                        <For each={assistantMessages()}>
                          {(assistantMessage) => <AssistantMessageItem message={assistantMessage} footer={props.footer} />}
                        </For>
                        <Show when={error()}>
                          <Card variant="error" class="error-card">
                            {error()?.data?.message as string}
                          </Card>
                        </Show>
                      </div>
                    </Show>
                    <Show when={!props.stepsExpanded && lastBlock()}>
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
                          data-open={diffsSectionOpen()}
                          aria-expanded={diffsSectionOpen()}
                          onClick={() => {
                            loadDiffBodies()
                            setDiffsSectionOpen(!diffsSectionOpen())
                          }}
                        >
                          <Icon name="chevron-down" size="small" data-slot="session-turn-summary-chevron" />
                          <h2 data-slot="session-turn-summary-title">
                            {i18n.t("ui.sessionTurn.summary.changedFiles")}
                          </h2>
                          <span data-slot="session-turn-summary-count">{messageDiffs().length}</span>
                        </button>
                        <Show when={diffsSectionOpen()}>
                          <Accordion
                            data-slot="session-turn-accordion"
                            multiple
                            value={diffsOpen()}
                            onChange={(value) => {
                              if (!Array.isArray(value)) return
                              setDiffsOpen(value)
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
                                    <Show
                                      when={
                                        diffsOpen().includes(diff.file!) &&
                                        (typeof diff.before === "string" || typeof diff.after === "string")
                                      }
                                    >
                                      <Dynamic
                                        component={diffComponent}
                                        before={{
                                          name: diff.file!,
                                          contents: diff.before ?? "",
                                        }}
                                        after={{
                                          name: diff.file!,
                                          contents: diff.after ?? "",
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
