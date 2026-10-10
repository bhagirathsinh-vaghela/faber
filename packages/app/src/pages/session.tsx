import {
  For,
  onCleanup,
  onMount,
  Show,
  Match,
  Switch,
  createMemo,
  createEffect,
  createSignal,
  on,
  untrack,
  type JSX,
} from "solid-js"
import { createCoarsePointer, preserveFocus, TOUCH_SLOP, useShell } from "@/utils/mobile"
import { createFocusSignal } from "@solid-primitives/active-element"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { Virtualizer, type VirtualizerHandle } from "virtua/solid"
import { Dynamic } from "solid-js/web"
import { useLocal } from "@/context/local"
import { selectionFromLines, useFile, type FileSelection, type SelectedLineRange } from "@/context/file"
import { diffSnippet, isDeletionOnly, previewLines } from "@/context/diff-snippet"
import { createStore } from "solid-js/store"
import { abortTurn, PromptInput } from "@/components/prompt-input"
import { QuestionPanel } from "@/components/question-panel"
import { MessageFooter } from "@/components/message-footer"
import { SessionContextUsage } from "@/components/session-context-usage"
import { useOpenContext } from "@/hooks/use-open-context"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { InlineInput } from "@opencode-ai/ui/inline-input"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Tabs } from "@opencode-ai/ui/tabs"
import { RadioGroup } from "@opencode-ai/ui/radio-group"
import { useCodeComponent } from "@opencode-ai/ui/context/code"
import { useDiffComponent } from "@opencode-ai/ui/context/diff"
import { LineComment as LineCommentView, LineCommentEditor } from "@opencode-ai/ui/line-comment"
import { findMarker } from "@opencode-ai/ui/diff-marker"
import { SessionTurn } from "@opencode-ai/ui/session-turn"
import { TranscriptCard } from "@opencode-ai/ui/transcript-card"
import { SessionReview } from "@opencode-ai/ui/session-review"
import { Mark } from "@opencode-ai/ui/logo"
import { Spinner } from "@opencode-ai/ui/spinner"
import { agentColor } from "@/utils/agent"
import { IDLE, busyBase, busyDelay, busyOverlays, busyShown } from "@opencode-ai/ui/util/busy-tint"
import { reply } from "@opencode-ai/ui/util/question"

import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { useSync } from "@/context/sync"
import { useMru } from "@/context/mru"
import { useTerminal, type LocalPTY } from "@/context/terminal"
import { useLayout } from "@/context/layout"
import { Terminal } from "@/components/terminal"
import { checksum, base64Encode } from "@opencode-ai/util/encode"
import { findLast } from "@opencode-ai/util/array"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogSelectFile } from "@/components/dialog-select-file"
import FileTree from "@/components/file-tree"
import { ReaderPill } from "@/components/reader-pill"
import { DialogSelectModel } from "@/components/dialog-select-model"
import { DialogMcpCorpus } from "@/components/dialog-mcp-corpus"
import { DialogFork } from "@/components/dialog-fork"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useNavigate, useParams } from "@solidjs/router"
import { UserMessage } from "@opencode-ai/sdk/v2"
import type { FileDiff } from "@opencode-ai/sdk/v2/client"
import { useSDK } from "@/context/sdk"
import { DEFAULT_PROMPT, isPromptEqual, usePrompt, type Prompt } from "@/context/prompt"
import { STASH_TOAST_MS, useStash } from "@/context/stash"
import { useRevertHost } from "@/context/revert"
import { DialogStash } from "@/components/dialog-stash"
import { DialogSubagents } from "@/components/dialog-subagents"
import { DialogOverview } from "@/components/dialog-overview"
import { useComments, type LineComment } from "@/context/comments"
import { useQuestion } from "@/context/question"
import { extractPromptFromParts } from "@/utils/prompt"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { usePermission } from "@/context/permission"
import { decode64 } from "@/utils/base64"
import { showToast } from "@opencode-ai/ui/toast"
import {
  SessionHeader,
  SessionContextTab,
  SortableTab,
  FileVisual,
  SortableTerminalTab,
  NewSessionView,
} from "@/components/session"
import { navMark, navParams } from "@/utils/perf"
import { same } from "@/utils/same"
import { probe } from "@/utils/transcript-probe"
import { Visibility } from "@/utils/visibility"

type DiffStyle = "unified" | "split"

const handoff = {
  prompt: "",
  terminals: [] as string[],
  files: {} as Record<string, SelectedLineRange | null>,
}

interface SessionReviewTabProps {
  diffs: () => FileDiff[]
  view: () => ReturnType<ReturnType<typeof useLayout>["view"]>
  diffStyle: DiffStyle
  onDiffStyleChange?: (style: DiffStyle) => void
  onViewFile?: (file: string) => void
  onOpenFile?: (file: string) => void
  onLineComment?: (comment: { file: string; selection: SelectedLineRange; comment: string; preview?: string }) => void
  comments?: LineComment[]
  focusedComment?: { file: string; id: string } | null
  onFocusedCommentChange?: (focus: { file: string; id: string } | null) => void
  focusedFile?: string
  onScrollRef?: (el: HTMLDivElement) => void
  classes?: {
    root?: string
    header?: string
    container?: string
  }
}

function StickyAddButton(props: { children: JSX.Element }) {
  const [stuck, setStuck] = createSignal(false)
  let button: HTMLDivElement | undefined

  createEffect(() => {
    const node = button
    if (!node) return

    const scroll = node.parentElement
    if (!scroll) return

    const handler = () => {
      const rect = node.getBoundingClientRect()
      const scrollRect = scroll.getBoundingClientRect()
      setStuck(rect.right >= scrollRect.right && scroll.scrollWidth > scroll.clientWidth)
    }

    scroll.addEventListener("scroll", handler, { passive: true })
    const observer = new ResizeObserver(handler)
    observer.observe(scroll)
    handler()
    onCleanup(() => {
      scroll.removeEventListener("scroll", handler)
      observer.disconnect()
    })
  })

  return (
    <div
      ref={button}
      class="bg-background-base h-full shrink-0 sticky right-0 z-10 flex items-center justify-center border-b border-border-weak-base px-3"
      classList={{ "border-l": stuck() }}
    >
      {props.children}
    </div>
  )
}

// Size-based default open set: small reviews expanded, large ones collapsed so
// the panel does not render dozens of diffs at once. Applied only until the
// user first toggles (layout reviewOpen is undefined).
function defaultReviewOpen(files: string[]) {
  return files.length > 10 ? [] : files
}

function SessionReviewTab(props: SessionReviewTabProps) {
  let scroll: HTMLDivElement | undefined
  let frame: number | undefined
  let pending: { x: number; y: number } | undefined

  const sdk = useSDK()

  const readFile = async (path: string) => {
    return sdk.client.file
      .read({ path })
      .then((x) => x.data)
      .catch(() => undefined)
  }

  // Single source of truth for expand/collapse: the layout store. Until the
  // user has ever toggled (reviewOpen undefined), fall back to the size-based
  // default — small reviews expanded, large ones collapsed. Snapshot that
  // default from the FIRST non-empty diff list and freeze it: computing it live
  // would let files streaming across the >10 boundary mid-turn flip the default
  // out from under the user during the pre-toggle window. Once frozen, the memo
  // never recomputes; any user toggle sets reviewOpen and the fallback stops.
  let snapshotted = false
  const defaultOpen = createMemo<string[]>(
    (prev) => {
      if (snapshotted) return prev
      const files = props.diffs().map((d) => d.file)
      if (!files.length) return prev
      snapshotted = true
      return defaultReviewOpen(files)
    },
    [],
    { equals: (a, b) => a === b },
  )
  const open = () => props.view().review.open() ?? defaultOpen()

  const restoreScroll = () => {
    const el = scroll
    if (!el) return

    const s = props.view().scroll("review")
    if (!s) return

    if (el.scrollTop !== s.y) el.scrollTop = s.y
    if (el.scrollLeft !== s.x) el.scrollLeft = s.x
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    pending = {
      x: event.currentTarget.scrollLeft,
      y: event.currentTarget.scrollTop,
    }
    if (frame !== undefined) return

    frame = requestAnimationFrame(() => {
      frame = undefined

      const next = pending
      pending = undefined
      if (!next) return

      props.view().setScroll("review", next)
    })
  }

  createEffect(
    on(
      () => props.diffs().length,
      () => {
        requestAnimationFrame(restoreScroll)
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
  })

  return (
    <SessionReview
      scrollRef={(el) => {
        scroll = el
        props.onScrollRef?.(el)
        restoreScroll()
      }}
      onScroll={handleScroll}
      onDiffRendered={() => requestAnimationFrame(restoreScroll)}
      open={open()}
      onOpenChange={props.view().review.setOpen}
      classes={{
        root: props.classes?.root ?? "pb-40",
        header: props.classes?.header ?? "px-6",
        container: props.classes?.container ?? "px-6",
      }}
      diffs={props.diffs()}
      diffStyle={props.diffStyle}
      onDiffStyleChange={props.onDiffStyleChange}
      onViewFile={props.onViewFile}
      onOpenFile={props.onOpenFile}
      focusedFile={props.focusedFile}
      readFile={readFile}
      onLineComment={props.onLineComment}
      comments={props.comments}
      focusedComment={props.focusedComment}
      onFocusedCommentChange={props.onFocusedCommentChange}
    />
  )
}

export default function Page() {
  const layout = useLayout()
  const local = useLocal()
  const file = useFile()
  const sync = useSync()
  const mru = useMru()
  const terminal = useTerminal()
  const dialog = useDialog()
  const codeComponent = useCodeComponent()
  const diffComponent = useDiffComponent()
  const command = useCommand()
  const language = useLanguage()
  const params = useParams()
  const navigate = useNavigate()
  const sdk = useSDK()
  const prompt = usePrompt()
  const stash = useStash()
  const revertHost = useRevertHost()
  const comments = useComments()
  const permission = usePermission()
  const question = useQuestion()

  // Permissions answered locally but not yet confirmed removed over SSE. On a
  // remote client that confirmation is a full round-trip away, and a prompt
  // that outlives the press by that long reads as a dead button.
  const [decided, setDecided] = createSignal<Set<string>>(new Set(), { equals: false })

  const request = createMemo(() => {
    const sessionID = params.id
    if (!sessionID) return
    const next = sync.data.permission[sessionID]?.find((p) => !decided().has(p.id))
    if (!next) return
    if (next.tool) return
    return next
  })

  const [ui, setUi] = createStore({
    pendingMessage: undefined as string | undefined,
    scrollGesture: 0,
    autoCreated: false,
  })

  createEffect(() => {
    const sessionID = params.id
    if (!sessionID) return
    const live = new Set((sync.data.permission[sessionID] ?? []).map((p) => p.id))
    const current = decided()
    if (![...current].some((id) => !live.has(id))) return
    setDecided((prev) => new Set([...prev].filter((id) => live.has(id))))
  })

  // The optimistic hide swaps the next queued permission's buttons into the
  // same screen position within a frame, so the second half of a double-click
  // would grant a permission the user never read. Ignore presses until the
  // replacement has been visible long enough to be seen.
  let decidedAt = 0
  const decide = (response: "once" | "always" | "reject") => {
    const perm = request()
    if (!perm) return
    const now = Date.now()
    if (now - decidedAt < 350) return
    decidedAt = now

    setDecided((prev) => new Set(prev).add(perm.id))
    sdk.client.permission
      .respond({ sessionID: perm.sessionID, permissionID: perm.id, response })
      .catch((err: unknown) => {
        setDecided((prev) => {
          const next = new Set(prev)
          next.delete(perm.id)
          return next
        })
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }
  const sessionKey = createMemo(() => `${params.dir}${params.id ? "/" + params.id : ""}`)
  const tabs = createMemo(() => layout.tabs(sessionKey))
  const view = createMemo(() => layout.view(sessionKey))

  createEffect(() => {
    if (params.id) layout.boxes.touch(params.id)
  })

  if (import.meta.env.DEV) {
    createEffect(
      on(
        () => [params.dir, params.id] as const,
        ([dir, id], prev) => {
          if (!id) return
          navParams({ dir, from: prev?.[1], to: id })
        },
      ),
    )

    createEffect(() => {
      const id = params.id
      if (!id) return
      if (!prompt.ready()) return
      navMark({ dir: params.dir, to: id, name: "storage:prompt-ready" })
    })

    createEffect(() => {
      const id = params.id
      if (!id) return
      if (!terminal.ready()) return
      navMark({ dir: params.dir, to: id, name: "storage:terminal-ready" })
    })

    createEffect(() => {
      const id = params.id
      if (!id) return
      if (!file.ready()) return
      navMark({ dir: params.dir, to: id, name: "storage:file-view-ready" })
    })

    createEffect(() => {
      const id = params.id
      if (!id) return
      if (sync.data.message[id] === undefined) return
      navMark({ dir: params.dir, to: id, name: "session:data-ready" })
    })
  }

  const wide = useShell().wide
  const centered = createMemo(() => wide() && !layout.fileTree.opened())
  const openContextPanel = useOpenContext()

  // The question and permission panels are siblings of the composer inside the
  // dock, so reader hides the composer alone and leaves the dock to size itself
  // around whichever of them is pending.
  const awaitingAnswer = createMemo(() => !!request() || question.count > 0)
  const reader = () => layout.reader.opened()
  const coarse = createCoarsePointer()
  // Sticky reader hides the composer; the non-sticky overlay (revealed) brings
  // it back over the transcript. Docked = reader on, nothing pending, and no
  // overlay up.
  const composerWanted = createMemo(() => layout.reader.revealed())
  const readerDocked = createMemo(() => reader() && !awaitingAnswer() && !composerWanted())
  // The clean read: sticky reader with no composer overlay up. This is the only
  // state that strips the pinned headers; non-sticky interactive keeps them, so
  // it looks exactly like sticky interactive apart from the mode being non-sticky.
  const cleanRead = createMemo(() => reader() && !layout.reader.revealed())
  // A signal rather than a read of document.activeElement, since the keybind
  // that stands down for the composer resolves `disabled` inside a memo, where a
  // bare DOM read is not tracked and so is never re-run when focus moves.
  const composerFocused = createFocusSignal(() => inputRef)
  // A soft keyboard is summoned by focus and dismissed by losing it, and it
  // covers more space than the composer it serves. A pending prompt owns the
  // dock and is the thing being answered, so it keeps the caret.
  createEffect(
    on(reader, (opened, was) => {
      if (opened) {
        inputRef?.blur()
        return
      }
      if (was === undefined || awaitingAnswer()) return
      // This effect is created far above the composer's own bindings, so Solid
      // runs it while that element is still hidden and inert, and neither can
      // take focus.
      requestAnimationFrame(() => command.trigger("prompt.focus.end"))
    }),
  )

  // Dropping the non-sticky overlay blurs so a caret left in the now-inert
  // composer cannot strand keyboard focus and swallow the transcript's bare-key
  // shortcuts.
  createEffect(
    on(composerWanted, (wanted, was) => {
      if (wanted || !was) return
      inputRef?.blur()
    }),
  )

  // Raising the non-sticky overlay. Whether it takes the caret depends on how it
  // was summoned, not the pointer: a keyboard summon (space) always focuses,
  // since the user is already typing; a tap focuses only on a fine pointer, so a
  // coarse tap doesn't raise the soft keyboard over what is being read. Deferred
  // because the composer is still hidden on this tick.
  const revealComposer = (focus = !coarse()) => {
    layout.reader.reveal()
    if (!focus) return
    requestAnimationFrame(() => command.trigger("prompt.focus.end"))
  }

  // A submit from the non-sticky overlay drops it back to the clean read; a
  // normal interactive submit leaves the mode alone.
  const onSubmit = () => {
    resumeScroll()
    layout.reader.returnIfRevealed()
  }

  function normalizeTab(tab: string) {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  function normalizeTabs(list: string[]) {
    const seen = new Set<string>()
    const next: string[] = []
    for (const item of list) {
      const value = normalizeTab(item)
      if (seen.has(value)) continue
      seen.add(value)
      next.push(value)
    }
    return next
  }

  const openTab = (value: string) => {
    const next = normalizeTab(value)
    tabs().open(next)

    const path = file.pathFromTab(next)
    if (!path) return
    file.load(path)
    showAllFiles()
  }

  createEffect(() => {
    const active = tabs().active()
    if (!active) return

    const path = file.pathFromTab(active)
    if (path) file.load(path)
  })

  createEffect(() => {
    const current = tabs().all()
    if (current.length === 0) return

    const next = normalizeTabs(current)
    if (same(current, next)) return

    tabs().setAll(next)

    const active = tabs().active()
    if (!active) return
    if (!active.startsWith("file://")) return

    const normalized = normalizeTab(active)
    if (active === normalized) return
    tabs().setActive(normalized)
  })

  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))

  const [renaming, setRenaming] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const [renameWidth, setRenameWidth] = createSignal("0px")
  let renameRef: HTMLInputElement | undefined
  let renameSizer: HTMLSpanElement | undefined

  const measureRename = (text: string) => {
    if (!renameSizer) return
    renameSizer.textContent = text
    const padding = 12
    setRenameWidth(`${Math.ceil(renameSizer.getBoundingClientRect().width) + padding}px`)
  }

  const startRename = () => {
    const current = info()
    if (!current?.title) return
    setDraft(current.title)
    setRenaming(true)
    requestAnimationFrame(() => {
      measureRename(current.title)
      renameRef?.focus()
    })
  }

  const commitRename = async () => {
    const current = info()
    const next = draft().trim()
    setRenaming(false)
    if (!current || !next || next === current.title) return
    await sdk.client.session.update({ sessionID: current.id, title: next })
  }

  const diffs = createMemo(() => (params.id ? (sync.data.session_diff[params.id] ?? []) : []))
  const reviewCount = createMemo(() => Math.max(info()?.summary?.files ?? 0, diffs().length))
  const hasReview = createMemo(() => reviewCount() > 0)
  const revertMessageID = createMemo(() => info()?.revert?.messageID)
  const messages = createMemo(() => (params.id ? (sync.data.message[params.id] ?? []) : []))
  const messagesReady = createMemo(() => {
    const id = params.id
    if (!id) return true
    return sync.data.message[id] !== undefined
  })
  const historyMore = createMemo(() => {
    const id = params.id
    if (!id) return false
    return sync.session.history.more(id)
  })
  const historyLoading = createMemo(() => {
    const id = params.id
    if (!id) return false
    return sync.session.history.loading(id)
  })
  const emptyUserMessages: UserMessage[] = []
  // One per turn: a question's answer is a user message inside the turn that asked.
  const userMessages = createMemo(
    () => messages().filter((m) => m.role === "user" && !reply(sync.data.part[m.id])) as UserMessage[],
    emptyUserMessages,
    { equals: same },
  )
  const visibleUserMessages = createMemo(
    () => {
      const revert = revertMessageID()
      if (!revert) return userMessages()
      return userMessages().filter((m) => m.id < revert)
    },
    emptyUserMessages,
    {
      equals: same,
    },
  )
  const revertedCount = createMemo(() => {
    const revert = revertMessageID()
    if (!revert) return 0
    return userMessages().filter((m) => m.id >= revert).length
  })
  const lastUserMessage = createMemo(() => visibleUserMessages().at(-1))

  const [store, setStore] = createStore({
    activeDraggable: undefined as string | undefined,
    activeTerminalDraggable: undefined as string | undefined,
    messageId: undefined as string | undefined,
    newSessionWorktree: "main",
    promptHeight: 0,
  })

  // The most recent turns render with their steps expanded by default; older
  // turns collapse to keep the transcript's DOM bounded on long sessions. An
  // explicit per-turn toggle always overrides this default.
  const recentTurns = 3
  const recentTurnIds = createMemo(() => {
    const msgs = visibleUserMessages()
    return new Set(msgs.slice(-recentTurns).map((m) => m.id))
  })
  const stepsBoxID = (messageID: string) => `${messageID}:steps`
  const stepsExpandedDefault = (messageID: string) =>
    (params.id ? layout.boxes.open(params.id, stepsBoxID(messageID)) : undefined) ?? recentTurnIds().has(messageID)
  const toggleSteps = (messageID: string) => {
    if (!params.id) return
    layout.boxes.setOpen(params.id, stepsBoxID(messageID), !stepsExpandedDefault(messageID))
  }

  const newSessionWorktree = createMemo(() => {
    if (store.newSessionWorktree === "create") return "create"
    const project = sync.project
    if (project && sync.data.path.directory !== project.worktree) return sync.data.path.directory
    return "main"
  })

  const activeMessage = createMemo(() => {
    if (!store.messageId) return lastUserMessage()
    const found = visibleUserMessages()?.find((m) => m.id === store.messageId)
    return found ?? lastUserMessage()
  })
  const setActiveMessage = (message: UserMessage | undefined) => {
    setStore("messageId", message?.id)
  }

  function navigateMessageByOffset(offset: number) {
    const msgs = visibleUserMessages()
    if (msgs.length === 0) return

    const current = activeMessage()
    const currentIndex = current ? msgs.findIndex((m) => m.id === current.id) : -1
    const targetIndex = currentIndex === -1 ? (offset > 0 ? 0 : msgs.length - 1) : currentIndex + offset
    if (targetIndex < 0 || targetIndex >= msgs.length) return

    // Reaching the last message is just another jump — select it and scroll to
    // it, but do NOT re-arm follow (no resumeScroll). Follow re-arms only
    // through the existing gesture path: a wheel/touch/scrollbar scroll that
    // actually lands at the bottom flips following back on in the onScroll
    // handler. alt+0 landing on the last prompt shouldn't force live-follow.
    setFollowing(false)
    scrollToMessage(msgs[targetIndex], "auto")
  }

  const kinds = createMemo(() => {
    const merge = (a: "add" | "del" | "mix" | undefined, b: "add" | "del" | "mix") => {
      if (!a) return b
      if (a === b) return a
      return "mix" as const
    }

    const normalize = (p: string) => p.replaceAll("\\\\", "/").replace(/\/+$/, "")

    const out = new Map<string, "add" | "del" | "mix">()
    for (const diff of diffs()) {
      const file = normalize(diff.file)
      const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

      out.set(file, kind)

      const parts = file.split("/")
      for (const [idx] of parts.slice(0, -1).entries()) {
        const dir = parts.slice(0, idx + 1).join("/")
        if (!dir) continue
        out.set(dir, merge(out.get(dir), kind))
      }
    }
    return out
  })
  const emptyDiffFiles: string[] = []
  const diffFiles = createMemo(() => diffs().map((d) => d.file), emptyDiffFiles, { equals: same })
  const diffsReady = createMemo(() => {
    const id = params.id
    if (!id) return true
    if (!hasReview()) return true
    return sync.data.session_diff[id] !== undefined
  })

  let inputRef!: HTMLDivElement
  let promptDock: HTMLDivElement | undefined
  let promptInner: HTMLDivElement | undefined
  let scroller: HTMLDivElement | undefined
  // A signal (not a plain ref) so the tail-follow ResizeObserver attaches
  // whenever the transcript (re)mounts; a bare `let` is invisible to it.
  const [content, setContent] = createSignal<HTMLDivElement>()
  // Same signal-mirror for `scroller`, for the keyboard re-pin observer.
  const [scrollerBox, setScrollerBox] = createSignal<HTMLDivElement>()

  const scrollGestureWindowMs = 250

  // True while settleToBottom's rAF loop is driving the scroller. Its own
  // scrollTop writes emit scroll events, and a gesture window left live by
  // momentum (each event re-extends it by 250ms) made onScroll read them as
  // user gestures — flipping following off mid-settle, which aborted the loop
  // and landed short. A fast middle-click after a scroll hit this every time;
  // press-and-hold only "worked" by outlasting the window. The pill arrow and
  // the End key take the same resumeScroll path and had the same latent bug.
  let settling = false

  let touchGesture: number | undefined

  const markScrollGesture = (target?: EventTarget | null) => {
    const root = scroller
    if (!root) return

    const el = target instanceof Element ? target : undefined
    const nested = el?.closest("[data-scrollable]")
    if (nested && nested !== root) return

    // A real gesture aborts an in-flight settle, so the user can always scroll
    // away mid-settle. Safe to do unconditionally: onScroll only re-extends the
    // window on the !settling branch, so its own call can never clear a live one.
    settling = false
    setUi("scrollGesture", Date.now())
  }

  const hasScrollGesture = () => Date.now() - ui.scrollGesture < scrollGestureWindowMs

  createEffect(
    on(
      () => params.id,
      (id, prev) => {
        // Leaving a session: evict the one we came from so its transcript stops
        // sitting in memory. evict keeps live sessions (and their children), so
        // an active session being juggled survives; only idle scrollback drops.
        if (prev && prev !== id) sync.session.evict(prev, id)
        if (!id) return
        mru.touch(id)
        // sync() scopes our event stream to this session and
        // awaits that subscribe before reading the snapshot, so no event is
        // dropped in the open-while-busy race. See sync.session.sync.
        void sync.session.sync(id)
      },
    ),
  )
  onCleanup(() => {
    sync.setOpenSession(undefined)
    // Evict on teardown so leaving to home or another project drops this
    // transcript from the store. evict targets only this id and keeps live
    // sessions, so it never drops a session being navigated to or a busy one.
    if (params.id) sync.session.evict(params.id)
  })

  // On reconnect, re-hydrate the open session so a message/part the server
  // published while the stream was down (no replay) heals without a reload.
  // First defer to server truth: a session deleted, or whose project was closed
  // from another client, has nothing left to render here, so go home rather than
  // resurrecting it.
  //
  // The reconnect signal also bumps on the FIRST connect, which races page load:
  // if this effect registers before that first bump, treating it as a reconnect
  // would navigate a freshly-opened idle session home. Gate the live-check on
  // having connected at least once, so only genuine RE-connects can bounce home;
  // the first connect only re-syncs.
  let connected = false
  createEffect(
    on(
      sync.reconnect,
      async () => {
        if (!params.id) return
        const reconnected = connected
        connected = true
        if (reconnected && !(await sync.session.reachable(params.id))) {
          navigate("/")
          return
        }
        void sync.session.sync(params.id, true)
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    if (!view().terminal.opened()) {
      setUi("autoCreated", false)
      return
    }
    if (!terminal.ready() || terminal.all().length !== 0 || ui.autoCreated) return
    terminal.new()
    setUi("autoCreated", true)
  })

  createEffect(
    on(
      () => terminal.all().length,
      (count, prevCount) => {
        if (prevCount !== undefined && prevCount > 0 && count === 0) {
          if (view().terminal.opened()) {
            view().terminal.toggle()
          }
        }
      },
    ),
  )

  createEffect(
    on(
      () => terminal.active(),
      (activeId) => {
        if (!activeId || !view().terminal.opened()) return
        // Immediately remove focus
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur()
        }
        const wrapper = document.getElementById(`terminal-wrapper-${activeId}`)
        const element = wrapper?.querySelector('[data-component="terminal"]') as HTMLElement
        if (!element) return

        // Find and focus the ghostty textarea (the actual input element)
        const textarea = element.querySelector("textarea") as HTMLTextAreaElement
        if (textarea) {
          textarea.focus()
          return
        }
        // Fallback: focus container and dispatch pointer event
        element.focus()
        element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }))
      },
    ),
  )

  createEffect(
    on(
      () => visibleUserMessages().at(-1)?.id,
      (lastId, prevLastId) => {
        // Snap the active message to the newest turn ONLY while following the
        // tail. If the user has navigated away with alt+9/alt+0 (following is
        // off), a new streamed turn must NOT reset their active message.
        if (!following()) return
        if (lastId && prevLastId && lastId > prevLastId) {
          setStore("messageId", undefined)
        }
      },
      { defer: true },
    ),
  )

  // The single busy read for this session, from the one operative store.
  const busy = createMemo(() => sync.data.session_busy[params.id ?? ""] ?? IDLE)
  // A subagent this session called is open (own turn may or may not also be running).
  const subagentBusy = createMemo(() => busy().subagents > 0)
  const titleWorking = createMemo(() => busyShown(busy()))
  const workingTint = createMemo(() => {
    const agent = local.agent.running()
    return agent ? agentColor(agent.name, agent.color) : undefined
  })
  const baseTint = createMemo(() => busyBase(busy(), workingTint()))
  const overlays = createMemo(() => busyOverlays(busy(), workingTint()))

  createEffect(
    on(
      () => params.id,
      () => {
        setStore("messageId", undefined)
      },
      { defer: true },
    ),
  )

  // Land focus in the dock when a session opens (fresh mount, direct URL, or an
  // in-session switch), so the user can type without clicking first. Keyed on
  // params.id, not onMount, because the view is reused across session switches.
  // Skip when another surface owns input: a pending question (its panel grabs
  // focus), the terminal, a dialog, or focus already sitting in an editable.
  let focusedFor: string | undefined
  createEffect(
    on(
      () => [params.id, prompt.ready()] as const,
      ([id, ready]) => {
        if (!ready) return
        // A brand-new session has no params.id yet (created on first submit), but
        // its prompt dock is already mounted. Key focus on a sentinel so the
        // new-session view lands the cursor once, same as an opened session.
        const key = id ?? "new"
        if (focusedFor === key) return
        if (id && (sync.data.question[id] ?? []).length > 0) return
        if (view().terminal.opened() || dialog.active) return
        const active = document.activeElement as HTMLElement | null
        if (active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) return
        focusedFor = key
        requestAnimationFrame(() => command.trigger("prompt.focus.end"))
      },
    ),
  )

  createEffect(() => {
    const id = lastUserMessage()?.id
    if (!id) return
    if ((busy().turn || subagentBusy()) && params.id) layout.boxes.setOpen(params.id, stepsBoxID(id), true)
  })

  const selectionPreview = (path: string, selection: FileSelection) => {
    const content = file.get(path)?.content?.content
    if (!content) return undefined
    const start = Math.max(1, Math.min(selection.startLine, selection.endLine))
    const end = Math.max(selection.startLine, selection.endLine)
    const lines = content.split("\n").slice(start - 1, end)
    if (lines.length === 0) return undefined
    return lines.slice(0, 2).join("\n")
  }

  const addSelectionToContext = (path: string, selection: FileSelection) => {
    const preview = selectionPreview(path, selection)
    prompt.context.add({ type: "file", path, selection, preview })
  }

  const addCommentToContext = (input: {
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
    origin?: "review" | "file"
  }) => {
    const selection = selectionFromLines(input.selection)
    const diff = diffs().find((d) => d.file === input.file)
    const hasBodies = typeof diff?.before === "string" && typeof diff?.after === "string"
    const snippet = hasBodies ? diffSnippet(diff!.before!, diff!.after!, input.selection) : undefined
    const deletionOnly = snippet ? isDeletionOnly(input.selection) : undefined
    // Preview from the correct side: a deletion selection indexes the old file,
    // so slicing the current (new) file would show the wrong lines.
    const side = deletionOnly ? diff!.before! : hasBodies ? diff!.after! : undefined
    const preview =
      input.preview ??
      (side !== undefined ? previewLines(side, input.selection) : selectionPreview(input.file, selection))
    const saved = comments.add({
      file: input.file,
      selection: input.selection,
      comment: input.comment,
    })
    prompt.context.add({
      type: "file",
      path: input.file,
      selection,
      comment: input.comment,
      commentID: saved.id,
      commentOrigin: input.origin,
      preview,
      snippet,
      deletionOnly,
    })
  }

  // What undo/redo last put in the prompt box. A box still holding exactly this
  // is ours to replace; anything else is a draft the user typed.
  let mirrored: Prompt | undefined

  // Undo never stops anything. Only the session's own turn blocks it: the
  // server refuses a revert while that turn runs, and a running subagent or job
  // is left alone on purpose, its late result committing the undo. The server's
  // refusal is checked too, since a delivered result can wake the turn a moment
  // before the client sees it.
  const reverting = async (sessionID: string, run: () => Promise<unknown>) => {
    const busyToast = () =>
      showToast({
        title: language.t("session.revert.busy.title"),
        description: language.t("session.revert.busy.description"),
        duration: STASH_TOAST_MS,
      })
    if (sync.data.session_busy[sessionID]?.turn) {
      busyToast()
      return false
    }
    return run().then(
      () => true,
      (err: unknown) => {
        const text =
          err instanceof Error ? err.message : ((err as { data?: { message?: string } })?.data?.message ?? "")
        if (text.includes("is busy")) busyToast()
        else
          showToast({
            variant: "error",
            title: language.t("session.revert.failed.title"),
            description: text.split("\n")[0],
          })
        return false
      },
    )
  }

  // The prompt box shows the first hidden message. A draft the user typed is
  // stashed before it is replaced, and kept in place if the stash fails. When
  // there is nothing typed to show (a job or subagent result is first hidden, or
  // a full redo hides nothing), only our own mirrored text is cleared; a real
  // draft stays put, since nothing would replace it.
  const mirror = async (message: UserMessage | undefined) => {
    const ours = mirrored !== undefined && isPromptEqual(prompt.current(), mirrored)
    const context = prompt.context.items()
    const draft = context.length > 0 || (prompt.dirty() && !ours)
    const next =
      message && !message.synthetic
        ? extractPromptFromParts(sync.data.part[message.id] ?? [], { directory: sdk.directory })
        : undefined
    if (!next || isPromptEqual(next, DEFAULT_PROMPT)) {
      if (draft) return
      prompt.reset()
      mirrored = undefined
      return
    }
    if (draft && !(await stash.push(prompt.current(), context, { title: language.t("stash.toast.draft") }))) return
    prompt.context.clear()
    prompt.set(next)
    mirrored = next
  }

  // "Revert here" on a user card. Cache-safe: the unrevert and the ping probe at
  // the prior assistant prime the cache before the new bookmark lands.
  revertHost.register(async (input) => {
    const target = userMessages().find((x) => x.id === input.messageID)
    const prior = messages().findLast((m) => m.id < input.messageID && m.role === "assistant")
    const done = await reverting(input.sessionID, async () => {
      await sdk.client.session.unrevert({ sessionID: input.sessionID })
      if (prior) await sdk.client.session.ping({ sessionID: input.sessionID, cacheProbeMessageID: prior.id })
      await sdk.client.session.revert({ sessionID: input.sessionID, messageID: input.messageID })
    })
    if (!done || input.sessionID !== params.id || !target) return
    await mirror(target)
  })

  command.register(() => [
    {
      id: "session.new",
      title: language.t("command.session.new"),
      category: language.t("command.category.session"),
      keybind: "mod+shift+s,alt+n",
      slash: "new",
      onSelect: () => navigate(`/${params.dir}/session`),
    },
    {
      id: "file.open",
      title: language.t("command.file.open"),
      description: language.t("palette.search.placeholder"),
      category: language.t("command.category.file"),
      keybind: "mod+p",
      slash: "open",
      onSelect: () => dialog.show(() => <DialogSelectFile onOpenFile={() => showAllFiles()} />),
    },
    {
      // Opens an empty non-sticky composer, the palette twin of the dead-space
      // tap. No keybind: typing a character reveals and lands that character
      // (the global type-to-reveal handler), so a bare space would type a space,
      // not open empty. Offered only in a clean read, where there is something to
      // reveal.
      id: "reader.composer.summon",
      title: language.t("command.reader.composer.summon"),
      description: language.t("command.reader.composer.summon.description"),
      category: language.t("command.category.view"),
      disabled: !reader() || layout.reader.revealed(),
      onSelect: () => revealComposer(true),
    },
    {
      // Stopping also sits in the composer's own key handler, which only runs
      // while it holds the caret. Reader takes the composer off screen and marks
      // the dock inert, so nothing was focused to receive Escape and the key did
      // nothing there. As a command it reaches from anywhere, and it stands down
      // while the composer holds the caret: the command layer fires in the
      // capture phase and would otherwise swallow the key before the handler
      // that resolves a popover or leaves shell mode.
      id: "session.stopTurn",
      title: language.t("command.session.stopTurn"),
      description: language.t("command.session.stopTurn.description"),
      category: language.t("command.category.session"),
      keybind: "escape",
      disabled: !params.id || !titleWorking() || composerFocused(),
      onSelect: () => {
        if (!params.id) return
        abortTurn(sdk.client, params.id)
      },
    },
    {
      id: "tab.close",
      title: language.t("command.tab.close"),
      category: language.t("command.category.file"),
      keybind: "mod+w",
      disabled: !tabs().active(),
      onSelect: () => {
        const active = tabs().active()
        if (!active) return
        tabs().close(active)
      },
    },
    {
      id: "context.addSelection",
      title: language.t("command.context.addSelection"),
      description: language.t("command.context.addSelection.description"),
      category: language.t("command.category.context"),
      keybind: "mod+shift+l",
      disabled: (() => {
        const active = tabs().active()
        if (!active) return true
        const path = file.pathFromTab(active)
        if (!path) return true
        return file.selectedLines(path) == null
      })(),
      onSelect: () => {
        const active = tabs().active()
        if (!active) return
        const path = file.pathFromTab(active)
        if (!path) return

        const range = file.selectedLines(path)
        if (!range) {
          showToast({
            title: language.t("toast.context.noLineSelection.title"),
            description: language.t("toast.context.noLineSelection.description"),
          })
          return
        }

        addSelectionToContext(path, selectionFromLines(range))
      },
    },
    {
      id: "context.view",
      title: language.t("command.context.view"),
      description: "",
      category: language.t("command.category.context"),
      onSelect: openContextPanel,
    },
    {
      id: "terminal.toggle",
      title: language.t("command.terminal.toggle"),
      description: "",
      category: language.t("command.category.view"),
      keybind: "ctrl+`",
      slash: "terminal",
      onSelect: () => view().terminal.toggle(),
    },
    {
      id: "review.toggle",
      title: language.t("command.review.toggle"),
      description: "",
      category: language.t("command.category.view"),
      // alt (not mod/ctrl) so it collides with no browser hard-reload:
      // Cmd+Shift+R on macOS and Ctrl+Shift+R on Windows/Linux both reload.
      keybind: "alt+shift+r",
      onSelect: () => layout.fileTree.toggle(),
    },
    {
      id: "terminal.new",
      title: language.t("command.terminal.new"),
      description: language.t("command.terminal.new.description"),
      category: language.t("command.category.terminal"),
      keybind: "ctrl+alt+t",
      onSelect: () => {
        if (terminal.all().length > 0) terminal.new()
        view().terminal.open()
      },
    },
    {
      id: "steps.toggle",
      title: language.t("command.steps.toggle"),
      description: language.t("command.steps.toggle.description"),
      category: language.t("command.category.view"),
      keybind: "mod+e",
      slash: "steps",
      disabled: !params.id,
      onSelect: () => {
        const msg = activeMessage()
        if (!msg) return
        toggleSteps(msg.id)
      },
    },
    {
      id: "message.previous",
      title: language.t("command.message.previous"),
      description: language.t("command.message.previous.description"),
      category: language.t("command.category.session"),
      keybind: "mod+arrowup,alt+9",
      disabled: !params.id,
      onSelect: () => navigateMessageByOffset(-1),
    },
    {
      id: "message.next",
      title: language.t("command.message.next"),
      description: language.t("command.message.next.description"),
      category: language.t("command.category.session"),
      keybind: "mod+arrowdown,alt+0",
      disabled: !params.id,
      onSelect: () => navigateMessageByOffset(1),
    },
    {
      id: "model.choose",
      title: language.t("command.model.choose"),
      description: language.t("command.model.choose.description"),
      category: language.t("command.category.model"),
      keybind: "mod+',alt+m",
      slash: "model",
      onSelect: () => dialog.show(() => <DialogSelectModel />),
    },
    {
      id: "mcp.manage",
      title: language.t("command.mcp.manage"),
      description: language.t("command.mcp.manage.description"),
      category: language.t("command.category.mcp"),
      keybind: "mod+;",
      slash: "mcp",
      onSelect: () => dialog.show(() => <DialogMcpCorpus />),
    },
    {
      id: "agent.cycle",
      title: language.t("command.agent.cycle"),
      description: language.t("command.agent.cycle.description"),
      category: language.t("command.category.agent"),
      keybind: "mod+.",
      slash: "agent",
      onSelect: () => local.agent.move(1),
    },
    {
      id: "agent.cycle.reverse",
      title: language.t("command.agent.cycle.reverse"),
      description: language.t("command.agent.cycle.reverse.description"),
      category: language.t("command.category.agent"),
      keybind: "shift+mod+.",
      onSelect: () => local.agent.move(-1),
    },
    {
      id: "model.variant.cycle",
      title: language.t("command.model.variant.cycle"),
      description: language.t("command.model.variant.cycle.description"),
      category: language.t("command.category.model"),
      onSelect: () => {
        local.model.variant.cycle()
      },
    },
    {
      id: "permissions.autoaccept",
      title:
        params.id && permission.isAutoAccepting(params.id, sdk.directory)
          ? language.t("command.permissions.autoaccept.disable")
          : language.t("command.permissions.autoaccept.enable"),
      category: language.t("command.category.permissions"),
      keybind: "mod+shift+a",
      disabled: !params.id || !permission.permissionsEnabled(),
      onSelect: () => {
        const sessionID = params.id
        if (!sessionID) return
        permission.toggleAutoAccept(sessionID, sdk.directory)
        showToast({
          title: permission.isAutoAccepting(sessionID, sdk.directory)
            ? language.t("toast.permissions.autoaccept.on.title")
            : language.t("toast.permissions.autoaccept.off.title"),
          description: permission.isAutoAccepting(sessionID, sdk.directory)
            ? language.t("toast.permissions.autoaccept.on.description")
            : language.t("toast.permissions.autoaccept.off.description"),
        })
      },
    },
    {
      id: "session.undo",
      title: language.t("command.session.undo"),
      description: language.t("command.session.undo.description"),
      category: language.t("command.category.session"),
      keybind: "alt+u",
      slash: "undo",
      disabled: !params.id || visibleUserMessages().length === 0,
      onSelect: async () => {
        const sessionID = params.id
        if (!sessionID) return
        const revert = info()?.revert?.messageID
        // Find the last user message that's not already reverted
        const message = findLast(userMessages(), (x) => !revert || x.id < revert)
        if (!message) return
        if (!(await reverting(sessionID, () => sdk.client.session.revert({ sessionID, messageID: message.id })))) return
        await mirror(message)
        // Navigate to the message before the reverted one (which will be the new last visible message)
        const priorMessage = findLast(userMessages(), (x) => x.id < message.id)
        setActiveMessage(priorMessage)
      },
    },
    {
      id: "session.redo",
      title: language.t("command.session.redo"),
      description: language.t("command.session.redo.description"),
      category: language.t("command.category.session"),
      keybind: "alt+r",
      slash: "redo",
      disabled: !params.id || !info()?.revert?.messageID,
      onSelect: async () => {
        const sessionID = params.id
        if (!sessionID) return
        const revertMessageID = info()?.revert?.messageID
        if (!revertMessageID) return
        const nextMessage = userMessages().find((x) => x.id > revertMessageID)
        if (!nextMessage) {
          // Full unrevert - restore all messages and navigate to last
          if (!(await reverting(sessionID, () => sdk.client.session.unrevert({ sessionID })))) return
          await mirror(undefined)
          // Navigate to the last message (the one that was at the revert point)
          const lastMsg = findLast(userMessages(), (x) => x.id >= revertMessageID)
          setActiveMessage(lastMsg)
          return
        }
        // Partial redo - move forward to next message
        if (!(await reverting(sessionID, () => sdk.client.session.revert({ sessionID, messageID: nextMessage.id }))))
          return
        await mirror(nextMessage)
        // Navigate to the message before the new revert point
        const priorMsg = findLast(userMessages(), (x) => x.id < nextMessage.id)
        setActiveMessage(priorMsg)
      },
    },
    {
      id: "session.compact",
      title: language.t("command.session.compact"),
      description: language.t("command.session.compact.description"),
      category: language.t("command.category.session"),
      slash: "compact",
      disabled: !params.id || visibleUserMessages().length === 0,
      onSelect: async () => {
        const sessionID = params.id
        if (!sessionID) return
        await sdk.client.session.summarize({ sessionID })
      },
    },
    {
      id: "session.fork",
      title: language.t("command.session.fork"),
      description: language.t("command.session.fork.description"),
      category: language.t("command.category.session"),
      keybind: "alt+o",
      slash: "fork",
      disabled: !params.id || visibleUserMessages().length === 0,
      onSelect: () => dialog.show(() => <DialogFork />),
    },
    {
      id: "prompt.stash",
      title: language.t("command.prompt.stash"),
      description: language.t("command.prompt.stash.description"),
      category: language.t("command.category.session"),
      keybind: "ctrl+s",
      disabled: !prompt.dirty(),
      onSelect: () => {
        void stash.push(prompt.current(), prompt.context.items())
        prompt.reset()
        prompt.context.clear()
      },
    },
    {
      id: "prompt.stash.list",
      title: language.t("command.prompt.stash.list"),
      description: language.t("command.prompt.stash.list.description"),
      category: language.t("command.category.session"),
      keybind: "ctrl+shift+s",
      onSelect: () => dialog.show(() => <DialogStash />),
    },
    {
      id: "subagent.list",
      title: language.t("command.subagent.list"),
      description: language.t("command.subagent.list.description"),
      category: language.t("command.category.session"),
      keybind: "alt+a",
      disabled: !params.id,
      onSelect: () => dialog.show(() => <DialogSubagents parentID={info()?.parentID} />),
    },
    {
      // Overrides the layout-level Ctrl+Tab while a session is open (session
      // commands register later, so they win the keybind). In a subagent
      // session, cycle its siblings; otherwise fall back to the session switcher.
      id: "session.switcher",
      title: language.t("command.session.switcher"),
      category: language.t("command.category.session"),
      keybind: "ctrl+tab",
      onSelect: (source) => {
        const parent = info()?.parentID
        const switcher = source === "keybind"
        if (parent)
          return dialog.show(() => (
            <DialogSubagents sessionID={parent} current={params.id} advance switcher={switcher} />
          ))
        dialog.show(() => <DialogOverview advance switcher={switcher} current={params.id} />)
      },
    },
    {
      id: "session.switcher.reverse",
      title: language.t("command.session.switcher.reverse"),
      category: language.t("command.category.session"),
      keybind: "ctrl+shift+tab",
      onSelect: (source) => {
        const parent = info()?.parentID
        const switcher = source === "keybind"
        if (parent)
          return dialog.show(() => <DialogSubagents sessionID={parent} current={params.id} switcher={switcher} />)
        dialog.show(() => <DialogOverview switcher={switcher} current={params.id} />)
      },
    },
    {
      id: "reader.toggle",
      title: language.t("command.reader.toggle"),
      description: language.t("command.reader.toggle.description"),
      category: language.t("command.category.session"),
      keybind: "alt+z",
      onSelect: () => layout.reader.toggle(),
    },
    ...(sync.data.config.share !== "disabled"
      ? [
          {
            id: "session.share",
            title: language.t("command.session.share"),
            description: language.t("command.session.share.description"),
            category: language.t("command.category.session"),
            slash: "share",
            disabled: !params.id || !!info()?.share?.url,
            onSelect: async () => {
              if (!params.id) return
              await sdk.client.session
                .share({ sessionID: params.id })
                .then((res) => {
                  navigator.clipboard.writeText(res.data!.share!.url).catch(() =>
                    showToast({
                      title: language.t("toast.session.share.copyFailed.title"),
                      variant: "error",
                    }),
                  )
                })
                .then(() =>
                  showToast({
                    title: language.t("toast.session.share.success.title"),
                    description: language.t("toast.session.share.success.description"),
                    variant: "success",
                  }),
                )
                .catch(() =>
                  showToast({
                    title: language.t("toast.session.share.failed.title"),
                    description: language.t("toast.session.share.failed.description"),
                    variant: "error",
                  }),
                )
            },
          },
          {
            id: "session.unshare",
            title: language.t("command.session.unshare"),
            description: language.t("command.session.unshare.description"),
            category: language.t("command.category.session"),
            slash: "unshare",
            disabled: !params.id || !info()?.share?.url,
            onSelect: async () => {
              if (!params.id) return
              await sdk.client.session
                .unshare({ sessionID: params.id })
                .then(() =>
                  showToast({
                    title: language.t("toast.session.unshare.success.title"),
                    description: language.t("toast.session.unshare.success.description"),
                    variant: "success",
                  }),
                )
                .catch(() =>
                  showToast({
                    title: language.t("toast.session.unshare.failed.title"),
                    description: language.t("toast.session.unshare.failed.description"),
                    variant: "error",
                  }),
                )
            },
          },
        ]
      : []),
  ])

  const handleKeyDown = (event: KeyboardEvent) => {
    // Home/End always jump the transcript to the top/bottom, even from the
    // prompt input (where they would otherwise just move the caret). Modifier
    // combos (cmd+End etc.) are left to the browser.
    const bare = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    if ((event.key === "End" || event.key === "Home") && bare) {
      if (dialog.active) return
      event.preventDefault()
      if (event.key === "End") {
        resumeScroll()
        // preventScroll: focusing the contenteditable (bottom of the dock)
        // otherwise triggers a browser scroll-into-view that fights
        // settleToBottom and lands the transcript short.
        inputRef?.focus({ preventScroll: true })
      } else jumpToTop()
      return
    }

    const activeElement = document.activeElement as HTMLElement | undefined

    if (activeElement) {
      const isProtected = activeElement.closest("[data-prevent-autofocus]")
      const isInput = /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(activeElement.tagName) || activeElement.isContentEditable
      if (isProtected || isInput) return
    }
    if (dialog.active) return

    // Don't autofocus chat if terminal panel is open
    if (view().terminal.opened()) return

    // Only treat explicit scroll keys as potential "user scroll" gestures.
    if (event.key === "PageUp" || event.key === "PageDown" || event.key === "Home" || event.key === "End") {
      markScrollGesture()
      return
    }

    if (event.key.length === 1 && event.key !== "Unidentified" && !(event.ctrlKey || event.metaKey)) {
      inputRef?.focus()
    }
  }

  // Middle mouse button = the scroll-to-bottom arrow (the pill above the dock),
  // then focus the prompt so the user can type. auxclick fires once on release
  // for non-primary buttons; button === 1 is the middle button. There is no
  // press-and-hold handling here — holding only ever appeared to matter because
  // a fast click landed inside the momentum-extended gesture window that used to
  // abort the settle. See the `settling` flag.
  const handleAuxClick = (event: MouseEvent) => {
    if (event.button !== 1) return
    if (dialog.active) return
    if (event.target instanceof Element && event.target.closest("a[href]")) return
    event.preventDefault()
    resumeScroll()
    // preventScroll: see the End-key branch — a bare focus() scroll-yanks the
    // transcript short.
    inputRef?.focus({ preventScroll: true })
  }

  const handleDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeDraggable", id)
  }

  const handleDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (draggable && droppable) {
      const currentTabs = tabs().all()
      const fromIndex = currentTabs?.indexOf(draggable.id.toString())
      const toIndex = currentTabs?.indexOf(droppable.id.toString())
      if (fromIndex !== toIndex && toIndex !== undefined) {
        tabs().move(draggable.id.toString(), toIndex)
      }
    }
  }

  const handleDragEnd = () => {
    setStore("activeDraggable", undefined)
  }

  const handleTerminalDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeTerminalDraggable", id)
  }

  const handleTerminalDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (draggable && droppable) {
      const terminals = terminal.all()
      const fromIndex = terminals.findIndex((t: LocalPTY) => t.id === draggable.id.toString())
      const toIndex = terminals.findIndex((t: LocalPTY) => t.id === droppable.id.toString())
      if (fromIndex !== -1 && toIndex !== -1 && fromIndex !== toIndex) {
        terminal.move(draggable.id.toString(), toIndex)
      }
    }
  }

  const handleTerminalDragEnd = () => {
    setStore("activeTerminalDraggable", undefined)
    const activeId = terminal.active()
    if (!activeId) return
    setTimeout(() => {
      const wrapper = document.getElementById(`terminal-wrapper-${activeId}`)
      const element = wrapper?.querySelector('[data-component="terminal"]') as HTMLElement
      if (!element) return

      // Find and focus the ghostty textarea (the actual input element)
      const textarea = element.querySelector("textarea") as HTMLTextAreaElement
      if (textarea) {
        textarea.focus()
        return
      }
      // Fallback: focus container and dispatch pointer event
      element.focus()
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }))
    }, 0)
  }

  const contextOpen = createMemo(() => tabs().active() === "context" || tabs().all().includes("context"))
  const openedTabs = createMemo(() =>
    tabs()
      .all()
      .filter((tab) => tab !== "context"),
  )

  // Without room for a split, an open review replaces the transcript rather
  // than sitting beside it. Same intent, different presentation.
  const reviewReplacesTranscript = createMemo(() => !wide() && layout.fileTree.opened())

  const fileTreeTab = () => layout.fileTree.tab()
  const setFileTreeTab = (value: "changes" | "all") => layout.fileTree.setTab(value)

  const [tree, setTree] = createStore({
    reviewScroll: undefined as HTMLDivElement | undefined,
    pendingDiff: undefined as string | undefined,
    activeDiff: undefined as string | undefined,
  })

  const reviewScroll = () => tree.reviewScroll
  const setReviewScroll = (value: HTMLDivElement | undefined) => setTree("reviewScroll", value)
  const pendingDiff = () => tree.pendingDiff
  const setPendingDiff = (value: string | undefined) => setTree("pendingDiff", value)
  const activeDiff = () => tree.activeDiff
  const setActiveDiff = (value: string | undefined) => setTree("activeDiff", value)

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    setFileTreeTab("all")
  }

  const reviewPanel = () => (
    <div class="flex flex-col h-full overflow-hidden bg-background-stronger contain-strict">
      <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
        <Switch>
          <Match when={hasReview()}>
            <Show
              when={diffsReady()}
              fallback={<div class="px-6 py-4 text-text-weak">{language.t("session.review.loadingChanges")}</div>}
            >
              <SessionReviewTab
                diffs={diffs}
                view={view}
                diffStyle={layout.review.diffStyle()}
                onDiffStyleChange={layout.review.setDiffStyle}
                onScrollRef={setReviewScroll}
                focusedFile={activeDiff()}
                onOpenFile={(path) => params.id && sync.session.diffFile(params.id, path)}
                onLineComment={(comment) => addCommentToContext({ ...comment, origin: "review" })}
                comments={comments.all()}
                focusedComment={comments.focus()}
                onFocusedCommentChange={comments.setFocus}
                onViewFile={(path) => {
                  showAllFiles()
                  const value = file.tab(path)
                  tabs().open(value)
                  file.load(path)
                }}
              />
            </Show>
          </Match>
          <Match when={true}>
            <div class="h-full px-6 pb-30 flex flex-col items-center justify-center text-center gap-6">
              <Mark class="w-14 opacity-10" />
              <div class="text-14-regular text-text-weak max-w-56">{language.t("session.review.empty")}</div>
            </div>
          </Match>
        </Switch>
      </div>
    </div>
  )

  const setFileTreeTabValue = (value: string) => {
    if (value !== "changes" && value !== "all") return
    setFileTreeTab(value)
  }

  const reviewDiffId = (path: string) => {
    const sum = checksum(path)
    if (!sum) return
    return `session-review-diff-${sum}`
  }

  const reviewDiffTop = (path: string) => {
    const root = reviewScroll()
    if (!root) return

    const id = reviewDiffId(path)
    if (!id) return

    const el = document.getElementById(id)
    if (!(el instanceof HTMLElement)) return
    if (!root.contains(el)) return

    const a = el.getBoundingClientRect()
    const b = root.getBoundingClientRect()
    return a.top - b.top + root.scrollTop
  }

  const scrollToReviewDiff = (path: string) => {
    const root = reviewScroll()
    if (!root) return false

    const top = reviewDiffTop(path)
    if (top === undefined) return false

    view().setScroll("review", { x: root.scrollLeft, y: top })
    root.scrollTo({ top, behavior: "auto" })
    return true
  }

  const focusReviewDiff = (path: string) => {
    // Honor the size-based default when the user has not toggled yet, so
    // focusing a file does not collapse the rest of a small (all-open) review.
    const current = view().review.open() ?? defaultReviewOpen(diffs().map((d) => d.file))
    if (!current.includes(path)) view().review.setOpen([...current, path])
    setActiveDiff(path)
    setPendingDiff(path)
  }

  createEffect(() => {
    const pending = pendingDiff()
    if (!pending) return
    if (!reviewScroll()) return
    if (!diffsReady()) return

    const attempt = (count: number) => {
      if (pendingDiff() !== pending) return
      // A large diff body can take well over a second to render; keep
      // retrying against the moving target so focus lands on the right file
      // instead of giving up at a stale offset.
      if (count > 180) {
        setPendingDiff(undefined)
        return
      }

      const root = reviewScroll()
      if (!root) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      if (!scrollToReviewDiff(pending)) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      const top = reviewDiffTop(pending)
      if (top === undefined) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      if (Math.abs(root.scrollTop - top) <= 1) {
        setPendingDiff(undefined)
        return
      }

      requestAnimationFrame(() => attempt(count + 1))
    }

    requestAnimationFrame(() => attempt(0))
  })

  const activeTab = createMemo(() => {
    const active = tabs().active()
    if (active === "context") return "context"
    if (active && file.pathFromTab(active)) return normalizeTab(active)

    const first = openedTabs()[0]
    if (first) return first
    if (contextOpen()) return "context"
    return "empty"
  })

  createEffect(() => {
    if (!layout.ready()) return
    if (tabs().active()) return
    if (openedTabs().length === 0 && !contextOpen()) return

    const next = activeTab()
    if (next === "empty") return
    tabs().setActive(next)
  })

  createEffect(() => {
    const id = params.id
    if (!id) return

    // The split shows a file tree that can sit on either tab; the replacing
    // presentation only ever shows changes, so it needs no tab test.
    const wants = layout.fileTree.opened() && (!wide() || fileTreeTab() === "changes")
    if (!wants) return
    if (sync.data.session_diff[id] !== undefined) return
    if (sync.status === "loading") return

    void sync.session.diff(id)
  })

  createEffect(() => {
    if (!wide()) return
    if (!layout.fileTree.opened()) return
    if (sync.status === "loading") return

    fileTreeTab()
    void file.tree.list("")
  })

  // `following` = the view is pinned to the tail. While it holds, every content
  // resize re-pins with a raw synchronous scrollTop write. virtua tracks native
  // scroll events, so a raw write does NOT desync its window — but its own
  // async scrollTo/scrollToIndex queue re-applies a stale eagerly-captured
  // offset on later size events, which is exactly what un-pins a growing tail.
  // So: raw pin while following; the handle's scrollToIndex ONLY to realize an
  // unmounted tail on long jumps (End from far up), where estimated sizes need
  // virtua's measure-retry loop.
  const [following, setFollowing] = createSignal(true)

  const lastIndex = () => visibleUserMessages().length - 1

  const atBottom = (el: HTMLElement) => el.scrollHeight - el.clientHeight - el.scrollTop <= 4

  // Live "is the tail visible" flag, updated on every scroll. The reader-toggle
  // re-pin needs the PRE-toggle state, but its effect runs after Solid has
  // already reflowed the transcript (title unmount, dock swap), so reading
  // atBottom() there is too late. This snapshot answers "were we at the bottom
  // just before the toggle" without touching the post-reflow DOM.
  let tailVisible = true

  const pinToBottom = () => {
    const el = scroller
    if (!el) return
    el.scrollTop = el.scrollHeight - el.clientHeight
  }

  // End/submit from far up the transcript: the tail may be unmounted with only
  // estimated sizes below the viewport, so one raw pin lands short. Let virtua
  // realize the last item, then raw-pin each frame until the bottom holds.
  //
  // Exit only once the bottom is STABLE: at-bottom AND scrollHeight unchanged for
  // a few consecutive frames. The tell that this is right: when the first press
  // lands short, an immediate second press always works — because by then the
  // last box / dock / busy bar has finished growing and scrollHeight has settled.
  // The old exit ("at-bottom for 2 frames") bailed mid-growth, pinning to a
  // scrollHeight that then kept increasing. Requiring height-stability makes the
  // FIRST press wait out that growth, so it behaves like the working second press.
  const settleToBottom = (tries = 0, lastHeight = -1, stable = 0) => {
    const el = scroller
    if (!el || !following()) {
      settling = false
      return
    }
    // Claim the scroller for the whole loop: every scroll event it emits from
    // here on is ours, so onScroll must not read it as a gesture. Cleared on
    // every exit below, and by markScrollGesture when a real gesture interrupts.
    settling = true
    const i = lastIndex()
    if (i >= 0 && !atBottom(el)) turnList()?.scrollToIndex(i, { align: "end" })
    pinToBottom()
    const streak = atBottom(el) && el.scrollHeight === lastHeight ? stable + 1 : 0
    if (tries > 120 || streak >= 3) {
      settling = false
      return
    }
    requestAnimationFrame(() => settleToBottom(tries + 1, el.scrollHeight, streak))
  }

  const clearMessageHash = () => {
    if (!window.location.hash) return
    window.history.replaceState(null, "", window.location.href.replace(/#.*$/, ""))
  }

  const resumeScroll = () => {
    setStore("messageId", undefined)
    // Explicitly asking for the tail (pill arrow, End, middle click) makes any
    // in-flight scroll gesture moot — void the window instead of waiting it out.
    // `settling` alone isn't enough: it only covers the rAF loop, and the window
    // outlives it (momentum re-extends it 250ms per event, the loop settles in
    // ~50ms). A late scroll in that gap — focus()'s scroll-into-view, or virtua
    // re-applying an offset — was still read as a gesture and unfollowed us 30px
    // short. Clearing it makes a fast click behave exactly like a slow one.
    setUi("scrollGesture", 0)
    setFollowing(true)
    settleToBottom()
    clearMessageHash()
  }

  // Follow the tail through EVERY kind of growth — streamed text, but also tool
  // boxes, diffs, code, and images rendering async. A data signal only sees
  // text length; a ResizeObserver on the scrolled content sees all of it. The
  // pin is a raw synchronous scrollTop write in the same frame, so the view
  // never paints off-bottom.
  createResizeObserver(content, () => {
    if (!following()) return
    pinToBottom()
  })

  // The soft keyboard resizes the scroller under the tail in BOTH directions
  // (on iOS standalone the root height tracks the visual viewport); nothing
  // else observes that, so the last card slides under the dock. Observe the
  // scroller's own box instead of viewport/focus events — iOS drops those
  // across some keyboard transitions, but the DOM resize is unmissable
  // whatever triggered it. Like the reader re-pin: a fresh following() read is
  // unreliable here (the transition's programmatic scroll churn can drop it),
  // so consult the pre-reflow tailVisible snapshot, re-assert, then settle.
  createResizeObserver(scrollerBox, (_, el) => {
    if (el !== scrollerBox()) return
    if (!following() && !tailVisible) return
    setFollowing(true)
    settleToBottom()
  })

  // A brand-new turn changes the list length before any content resize; settle
  // (not bare pin) because the new tail may mount with only an estimated size.
  createEffect(
    on(
      () => lastUserMessage()?.id,
      () => {
        if (following()) settleToBottom()
      },
      { defer: true },
    ),
  )

  // When the user returns to the bottom, treat the active message as "latest".
  createEffect(
    on(
      following,
      (f) => {
        if (!f) return
        setStore("messageId", undefined)
        clearMessageHash()
      },
      { defer: true },
    ),
  )

  let scrollSpyFrame: number | undefined
  let scrollSpyTarget: HTMLDivElement | undefined

  const anchor = (id: string) => `message-${id}`

  // A transcript element does its own thing on a tap (copy inline code, open an
  // overlay, follow a link); only a tap that lands on none of them is read as
  // "toggle the chrome". The dock and the pill cluster are excluded so a tap
  // there is never mistaken for dead space. A diff renders in a shadow root, so
  // its inner clicks retarget to the [data-component="diff"] host, which is what
  // the closest test sees; any future shadow-DOM card needs its host listed too.
  const interactive = (target: EventTarget | null) =>
    target instanceof Element &&
    !!target.closest(
      'button, a, input, textarea, select, [contenteditable="true"], [role="button"], [data-scrollable], [data-slot="prompt-dock"], [data-reader-cluster], [data-copyable], code, details, summary, [data-component="icon-button"], [data-component="diff"], [data-component="markdown-code"], [data-slot="user-message-attachment"]',
    )

  const setScrollRef = (el: HTMLDivElement | undefined) => {
    scroller = el
    setScrollerBox(el)
    if (!el) return

    // A tap on dead space drives the NON-STICKY overlay, never the sticky mode:
    // in sticky reader it raises the composer, and while that overlay is up it
    // drops it back to the clean read. So a stray tap only summons or dismisses
    // a composer, never flips sticky mode (that is the book orb / alt+z). In
    // sticky interactive there is no dead space to speak of and nothing to do.
    // A tap on an interactive element does its own thing, and a scroll (pointer
    // past the slop) never toggles.
    //
    // Fired on pointerup rather than click to skip the touch browsers' tap
    // latency: click waits out the double-tap/scroll window before dispatching,
    // which lags the toggle on touch. pointerup lands the moment the finger
    // lifts. The slop check is what click gave for free (a scroll fires no
    // click); we re-derive it from the pointerdown position.
    let downX = 0
    let downY = 0
    const onDown = (event: PointerEvent) => {
      downX = event.clientX
      downY = event.clientY
    }
    const onUp = (event: PointerEvent) => {
      if (!reader()) return
      if (event.button !== 0) return
      if (Math.hypot(event.clientX - downX, event.clientY - downY) >= TOUCH_SLOP) return
      if (interactive(event.target)) return
      if (layout.reader.revealed()) layout.reader.returnIfRevealed()
      else revealComposer()
    }
    el.addEventListener("pointerdown", onDown)
    el.addEventListener("pointerup", onUp)
    onCleanup(() => {
      el.removeEventListener("pointerdown", onDown)
      el.removeEventListener("pointerup", onUp)
    })
  }

  // virtua owns turn windowing: it keeps only the visible range (+bufferSize)
  // mounted and props the scroller to full estimated height, so scrollHeight
  // stays honest for the tail-follow/restore logic below. Its handle drives
  // every jump-to-turn (Home/End/deep-link/prev-next) via scrollToIndex, which
  // realizes an unmounted target before scrolling — the DOM getElementById path
  // alone can't reach a turn that isn't rendered.
  const [turnList, setTurnList] = createSignal<VirtualizerHandle | undefined>()
  const turnIndex = (messageID: string) => visibleUserMessages().findIndex((m) => m.id === messageID)

  // The transcript's one invariant: turns in the store must reach the screen.
  //
  // The scroll range is estimated (itemSize above), and a real turn runs several
  // times that, so the bottom the tail-follow loop pins to can sit far past where
  // the measured content ends. The list still admits a row to its range and lays
  // it out honestly — at an offset now outside the visible box, with the loop
  // re-pinning every frame so no scroll gesture escapes. Measured on iPadOS
  // against a ten-turn session: one row mounted, none of it overlapping the
  // 1131px box, and a scrollTop write to 0 read back at 7183 a half-second on.
  //
  // The store is untouched throughout, which is why the dock keeps reporting
  // token counts for a session that shows nothing. Checking the OUTCOME rather
  // than any single cause covers the other paths that stale a measurement the
  // same way — a display:none ancestor, or a backgrounded tab, either of which
  // makes the list's own ResizeObserver drop the entries it needs.
  const showing = () => {
    const el = scroller
    if (!el) return 0
    const box = el.getBoundingClientRect()
    if (box.height <= 0) return 0
    let count = 0
    for (const node of Array.from(document.querySelectorAll("[data-message-id]"))) {
      const rect = node.getBoundingClientRect()
      if (rect.bottom > box.top && rect.top < box.bottom) count += 1
    }
    return count
  }

  const reviveTranscript = () => {
    const handle = turnList()
    const el = scroller
    if (!handle || !el) return

    const turns = visibleUserMessages().length
    if (turns === 0) return
    if (el.clientHeight <= 0) return
    if (showing() > 0) return

    probe("revive", {
      viewport: handle.viewportSize,
      mounted: document.querySelectorAll("[data-message-id]").length,
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      turns,
    })

    // scrollToIndex re-derives the range from measured sizes, where a raw
    // scrollTop write would land against the same estimate that put the row out
    // of sight, and the tail-follow loop would drag it back regardless.
    const target = activeMessage()?.id ?? visibleUserMessages().at(-1)?.id
    if (!target) return
    const index = turnIndex(target)
    if (index < 0) return
    handle.scrollToIndex(index, { align: following() ? "end" : "start" })

    requestAnimationFrame(() =>
      probe("revive.done", { showing: showing(), scrollTop: el.scrollTop, scrollHeight: el.scrollHeight }),
    )
  }

  // True exactly when the turn list changed by gaining items at its head
  // (history load-earlier) within the same session: the previous head is still
  // present but an older message now precedes it. Message IDs sort by age.
  const prepended = createMemo(
    (prev: { head: string | undefined; session: string | undefined; value: boolean }) => {
      const head = visibleUserMessages()[0]?.id
      const session = params.id
      const value = session === prev.session && !!prev.head && !!head && head < prev.head
      return { head, session, value }
    },
    { head: undefined, session: undefined, value: false },
  )

  // Two frames, because one is not enough to tell a blank transcript from a
  // pending one: virtua admits a row to its range in the frame after the box
  // that sized it, and mounts it in the frame after that. Checking sooner reads
  // a list that is merely mid-mount and repairs something that was never broken.
  const checkTranscript = () => requestAnimationFrame(() => requestAnimationFrame(reviveTranscript))

  // Everything that can leave the measurement stale converges on these: hiding
  // or showing any ancestor resizes the scroller, the tab returning to the
  // foreground restores the offsetParent whose absence dropped the entries, and
  // a session switch rebuilds the list under a box it may never have measured.
  createEffect(
    on(
      () => [params.id, visibleUserMessages().length, Visibility.hidden()],
      () => {
        if (Visibility.hidden()) return
        checkTranscript()
      },
    ),
  )

  createResizeObserver(scrollerBox, (_, el) => {
    if (el !== scrollerBox()) return
    checkTranscript()
  })

  createResizeObserver(
    () => promptDock,
    () => {
      if (!promptDock) return
      // The column's padding is the gap it owes the transcript above and the
      // window below, so both belong in the height the transcript clears.
      const next = Math.max(0, Math.ceil(promptDock.offsetHeight))
      if (next === store.promptHeight) return

      setStore("promptHeight", next)
    },
  )

  // One measurement of the whole column, so whatever is inside it — busy bar,
  // question panel, composer, or nothing — is already accounted for by the time
  // the transcript reads this. Nothing inside adds its own height on top, and
  // the breathing room above the column is carried here rather than re-added by
  // each consumer.
  createEffect(() => {
    const next = store.promptHeight
    // On the root element, not the session panel: the dictation overlay
    // portals to <body> and would otherwise inherit nothing to anchor to.
    document.documentElement.style.setProperty("--prompt-height", `${next}px`)

    // A taller dock covers the tail; re-pin if following. The dock grows when
    // the busy bar mounts mid-stream, and the height change propagates through
    // --prompt-height -> last-turn padding -> scrollHeight over SEVERAL frames,
    // not one. A single pinToBottom lands the first frame and then the padding
    // keeps growing, leaving the view short (the busy-session bug). settle each
    // frame until the bottom holds.
    //
    // Untracked: a clearance change is the trigger. Subscribing to the flag
    // would launch a second settle loop from each of the many places that
    // re-assert follow, and two loops racing overwrite each other's counters.
    if (untrack(following)) settleToBottom()
  })

  // Reader reflows the tail in ways the content ResizeObserver
  // can't catch: the sticky session title (a scroller child, not virtua content)
  // unmounts, the scroller's --session-title-height flips, and the dock's
  // reserved clearance changes. The scroller runs overflow-anchor:none (virtua needs it to avoid
  // oscillation), so the browser no longer compensates these height changes the
  // way it did before virtua. The tail slides under the dock and stays there.
  //
  // Kick a re-pin from the pre-toggle snapshot (a fresh atBottom() read here is
  // too late, the DOM already reflowed). The single pin lands the first frame;
  // the onScroll re-pin below then keeps the tail glued as the dock/title reflow
  // and virtua's later size-change compensation arrive over subsequent frames.
  createEffect(
    on(
      () => [reader(), awaitingAnswer()],
      () => {
        const el = scroller
        if (!el) return
        // Use the pre-toggle snapshot, NOT a fresh atBottom() read: by the time
        // this effect runs the transcript has already reflowed, so a live read
        // would report off-bottom and we'd wrongly skip.
        if (!following() && !tailVisible) return
        // Re-assert following; the onScroll re-pin then keeps the tail glued as
        // the dock/title reflow and virtua's compensation land over later frames.
        setFollowing(true)
        requestAnimationFrame(pinToBottom)
      },
      { defer: true },
    ),
  )

  const updateHash = (id: string) => {
    window.history.replaceState(null, "", `#${anchor(id)}`)
  }

  createEffect(() => {
    const sessionID = params.id
    if (!sessionID) return
    const raw = sessionStorage.getItem("opencode.pendingMessage")
    if (!raw) return
    const parts = raw.split("|")
    const pendingSessionID = parts[0]
    const messageID = parts[1]
    if (!pendingSessionID || !messageID) return
    if (pendingSessionID !== sessionID) return

    sessionStorage.removeItem("opencode.pendingMessage")
    setUi("pendingMessage", messageID)
  })

  const scrollToElement = (el: HTMLElement, behavior: ScrollBehavior) => {
    const root = scroller
    if (!root) return false

    const a = el.getBoundingClientRect()
    const b = root.getBoundingClientRect()
    // The scroller has a sticky session-title bar pinned at its top. Offset the
    // target by its height (plus a small gap) so a jumped-to message lands just
    // below the bar instead of clipped underneath it.
    const titleHeight = parseFloat(getComputedStyle(root).getPropertyValue("--session-title-height")) || 0
    const top = a.top - b.top + root.scrollTop - titleHeight - 8
    root.scrollTo({ top: Math.max(0, top), behavior })
    return true
  }

  // A long jump from an unmounted target undershoots on the first scrollToIndex
  // because virtua only has estimated sizes for the turns in between; it homes
  // in as those get measured. So re-issue scrollToIndex each frame until the
  // target's DOM element exists, then hand off to a DOM scroll that lands it
  // under the sticky title bar (virtua aligns to the scroller top, which the
  // sticky title would otherwise clip).
  const settleToMessage = (messageID: string, behavior: ScrollBehavior, tries = 0) => {
    const el = document.getElementById(anchor(messageID))
    if (el && scrollToElement(el, behavior)) return
    if (tries > 30) return
    const index = turnIndex(messageID)
    if (index !== -1) turnList()?.scrollToIndex(index, { align: "start" })
    requestAnimationFrame(() => settleToMessage(messageID, behavior, tries + 1))
  }

  const scrollToMessage = (message: UserMessage, behavior: ScrollBehavior = "smooth") => {
    // Jumping to a message is a deliberate move away from the tail, so stop
    // auto-follow first. Without this, a click while the session streams
    // scrolls up and then the resize re-pin drags the view back to the bottom.
    setFollowing(false)
    setActiveMessage(message)
    updateHash(message.id)
    settleToMessage(message.id, behavior)
  }

  // Restoring the tail (reload, reconnect, submit): mark following and settle;
  // the content ResizeObserver then keeps the tail pinned as content grows in.
  const restoreScroll = () => {
    if (hasScrollGesture()) return
    setFollowing(true)
    settleToBottom()
  }

  const jumpToTop = () => {
    if (hasScrollGesture()) return
    setFollowing(false)
    turnList()?.scrollToIndex(0, { align: "start" })
  }

  const applyHash = (behavior: ScrollBehavior) => {
    const hash = window.location.hash.slice(1)
    if (!hash) {
      restoreScroll()
      return
    }

    const match = hash.match(/^message-(.+)$/)
    if (match) {
      setFollowing(false)
      const msg = visibleUserMessages().find((m) => m.id === match[1])
      if (msg) {
        scrollToMessage(msg, behavior)
        return
      }

      // A message hash whose message isn't loaded yet leaves the view where it
      // is rather than falling back to the bottom. Nothing retries it.
      return
    }

    const target = document.getElementById(hash)
    if (target) {
      setFollowing(false)
      scrollToElement(target, behavior)
      return
    }

    // Unresolvable hash: land at the tail, following.
    setFollowing(true)
    settleToBottom()
  }

  const closestMessage = (node: Element | null): HTMLElement | null => {
    if (!node) return null
    const match = node.closest?.("[data-message-id]") as HTMLElement | null
    if (match) return match
    const root = node.getRootNode?.()
    if (root instanceof ShadowRoot) return closestMessage(root.host)
    return null
  }

  const getActiveMessageId = (container: HTMLDivElement) => {
    const rect = container.getBoundingClientRect()
    if (!rect.width || !rect.height) return

    const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2))
    const y = Math.min(window.innerHeight - 1, Math.max(0, rect.top + 100))

    const hit = document.elementFromPoint(x, y)
    const host = closestMessage(hit)
    const id = host?.dataset.messageId
    if (id) return id

    // Fallback: DOM query (handles edge hit-testing cases)
    const cutoff = container.scrollTop + 100
    const nodes = container.querySelectorAll<HTMLElement>("[data-message-id]")
    let last: string | undefined

    for (const node of nodes) {
      const next = node.dataset.messageId
      if (!next) continue
      if (node.offsetTop > cutoff) break
      last = next
    }

    return last
  }

  const scheduleScrollSpy = (container: HTMLDivElement) => {
    scrollSpyTarget = container
    if (scrollSpyFrame !== undefined) return

    scrollSpyFrame = requestAnimationFrame(() => {
      scrollSpyFrame = undefined

      const target = scrollSpyTarget
      scrollSpyTarget = undefined
      if (!target) return

      const id = getActiveMessageId(target)
      if (!id) return
      if (id === store.messageId) return

      setStore("messageId", id)
    })
  }

  createEffect(() => {
    const sessionID = params.id
    const ready = messagesReady()
    if (!sessionID || !ready) return

    // Initial reload always pins to the bottom. A #message-<id> hash left over
    // from an in-session jump (onJump/keyboard nav) must not "stick" across a
    // reload, so drop it and restore to the tail. Non-message hashes (element
    // deep-links) still resolve via applyHash.
    requestAnimationFrame(() => {
      if (/^#message-/.test(window.location.hash)) {
        clearMessageHash()
        restoreScroll()
        return
      }
      applyHash("auto")
    })
  })

  // Retry message navigation once the target message is actually loaded.
  createEffect(() => {
    const sessionID = params.id
    const ready = messagesReady()
    if (!sessionID || !ready) return

    // dependencies
    visibleUserMessages().length

    const targetId = ui.pendingMessage
    if (!targetId) return
    if (store.messageId === targetId) return

    const msg = visibleUserMessages().find((m) => m.id === targetId)
    if (!msg) return
    setUi("pendingMessage", undefined)
    setFollowing(false)
    requestAnimationFrame(() => scrollToMessage(msg, "auto"))
  })

  createEffect(() => {
    const sessionID = params.id
    const ready = messagesReady()
    if (!sessionID || !ready) return

    const handler = () => requestAnimationFrame(() => applyHash("auto"))
    window.addEventListener("hashchange", handler)
    onCleanup(() => window.removeEventListener("hashchange", handler))
  })

  createEffect(() => {
    document.addEventListener("keydown", handleKeyDown)
    document.addEventListener("auxclick", handleAuxClick)
  })

  const previewPrompt = () =>
    prompt
      .current()
      .map((part) => {
        if (part.type === "file") return `[file:${part.path}]`
        if (part.type === "agent") return `@${part.name}`
        if (part.type === "image") return `[image:${part.filename}]`
        return part.content
      })
      .join("")
      .trim()

  createEffect(() => {
    if (!prompt.ready()) return
    handoff.prompt = previewPrompt()
  })

  createEffect(() => {
    if (!terminal.ready()) return
    language.locale()

    const label = (pty: LocalPTY) => {
      const title = pty.title
      const number = pty.titleNumber
      const match = title.match(/^Terminal (\d+)$/)
      const parsed = match ? Number(match[1]) : undefined
      const isDefaultTitle = Number.isFinite(number) && number > 0 && Number.isFinite(parsed) && parsed === number

      if (title && !isDefaultTitle) return title
      if (Number.isFinite(number) && number > 0) return language.t("terminal.title.numbered", { number })
      if (title) return title
      return language.t("terminal.title")
    }

    handoff.terminals = terminal.all().map(label)
  })

  createEffect(() => {
    if (!file.ready()) return
    handoff.files = Object.fromEntries(
      tabs()
        .all()
        .flatMap((tab) => {
          const path = file.pathFromTab(tab)
          if (!path) return []
          return [[path, file.selectedLines(path) ?? null] as const]
        }),
    )
  })

  onCleanup(() => {
    document.removeEventListener("keydown", handleKeyDown)
    document.removeEventListener("auxclick", handleAuxClick)
    if (scrollSpyFrame !== undefined) cancelAnimationFrame(scrollSpyFrame)
  })

  // Desktop pill hugs the top-right corner of the visible input box, so it
  // never floats over the input or lands in the centered layout's side gutter.
  // Track that box's viewport rect; the corner anchor is derived from it.
  // Re-measured on dock resize, reader toggle, file-tree/centering changes, and
  // window resize.
  const [dockRect, setDockRect] = createSignal<{ right: number; top: number } | null>(null)
  const measureDock = () => {
    // A dock hidden by reader would drag the pill down with it, taking
    // the only way out of reader off the viewport. Null hands the pill its
    // corner. Keyed to whether the dock actually left, not to reader itself: a
    // summoned composer is on screen and the cluster has to sit above it rather
    // than over it.
    if (readerDocked()) {
      setDockRect(null)
      return
    }
    // Anchor to the input box itself, not promptInner (the dock content column).
    // promptInner stacks the question panel, permission prompt, and busy bar
    // ABOVE the input, so its top edge rises when any of those appear and the
    // pill would ride up with it. The input box's top edge is stable.
    // inputRef is the contenteditable; its form wrapper spans the box.
    const el = inputRef?.closest("form")
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.width === 0) return
    // getBoundingClientRect is visual-viewport-relative, but the pill is
    // position:fixed (layout-viewport-relative). When the mobile keyboard shifts
    // the visual viewport, the two diverge by visualViewport.offsetTop/Left —
    // uncompensated, the pill flies way up. Add the offset so top/right land in
    // the layout-viewport coordinate space the fixed pill actually uses.
    const vv = window.visualViewport
    const right = r.right + (vv?.offsetLeft ?? 0)
    const top = r.top + (vv?.offsetTop ?? 0)
    setDockRect({ right, top })
  }
  createEffect(() => {
    // Depend on the triggers that move the box, then measure post-layout.
    void store.promptHeight
    void readerDocked()
    void centered()
    requestAnimationFrame(measureDock)
  })
  onMount(() => {
    window.addEventListener("resize", measureDock)
    onCleanup(() => window.removeEventListener("resize", measureDock))
    // window "resize" fires when the mobile keyboard opens but often NOT when it
    // dismisses (iOS restores the visual viewport without one), so the pill's
    // measured top stays stale-high while the CSS bottom:0 dock snaps back down.
    // visualViewport fires on both show and hide — re-measure so the pill tracks
    // the dock back down too.
    const vv = window.visualViewport
    if (vv) {
      vv.addEventListener("resize", measureDock)
      vv.addEventListener("scroll", measureDock)
      onCleanup(() => {
        vv.removeEventListener("resize", measureDock)
        vv.removeEventListener("scroll", measureDock)
      })
    }
  })

  return (
    <div
      class="relative bg-background-base size-full overflow-hidden flex flex-col"
      // Inherited by both permission prompts (the dock's and the in-transcript
      // one), so they carry the same agent tint as the question panel's border.
      style={{ "--permission-accent": workingTint() ?? "var(--icon-interactive-base)" }}
    >
      <SessionHeader />
      {/* Anchored just above the prompt dock; the held dock height keeps it put
          across the reader toggle. */}
      <ReaderPill anchor={dockRect} />
      <div class="flex-1 min-h-0 flex flex-col wide:flex-row">
        {/* Session panel */}
        <div
          classList={{
            "@container/panel relative shrink-0 flex flex-col min-h-0 h-full bg-background-stronger": true,
            // No padding at any size: the titlebar already leaves slack under
            // its icon row, so anything here reads as a gap the title is
            // floating in rather than as breathing room.
            "flex-1 pt-0": true,
            "wide:flex-none": layout.fileTree.opened(),
          }}
          style={{
            width: wide() && layout.fileTree.opened() ? `${layout.session.width()}px` : "100%",
            // The clean read hides the titlebar, so on mobile the panel must clear
            // the top safe-area inset the titlebar was covering; --sat is 0
            // elsewhere, so this reserves exactly the status bar and nothing more.
            "padding-top": layout.reader.cleanRead() ? "var(--sat)" : undefined,
          }}
        >
          <div class="flex-1 min-h-0 overflow-hidden">
            <Switch>
              <Match when={params.id}>
                <Show
                  when={messagesReady()}
                  fallback={
                    <div class="flex-1 flex items-center justify-center text-text-weak">
                      <Spinner class="size-6" />
                    </div>
                  }
                >
                  <Show
                    when={!reviewReplacesTranscript()}
                    fallback={
                      <div class="relative h-full overflow-hidden">
                        <Switch>
                          <Match when={hasReview()}>
                            <Show
                              when={diffsReady()}
                              fallback={
                                <div class="px-4 py-4 text-text-weak">
                                  {language.t("session.review.loadingChanges")}
                                </div>
                              }
                            >
                              <SessionReviewTab
                                diffs={diffs}
                                view={view}
                                diffStyle={layout.review.narrowDiffStyle()}
                                onDiffStyleChange={layout.review.setNarrowDiffStyle}
                                focusedFile={activeDiff()}
                                onOpenFile={(path) => params.id && sync.session.diffFile(params.id, path)}
                                onLineComment={(comment) => addCommentToContext({ ...comment, origin: "review" })}
                                comments={comments.all()}
                                focusedComment={comments.focus()}
                                onFocusedCommentChange={comments.setFocus}
                                onViewFile={(path) => {
                                  showAllFiles()
                                  const value = file.tab(path)
                                  tabs().open(value)
                                  file.load(path)
                                }}
                                classes={{
                                  root: "pb-(--prompt-height)",
                                  header: "px-4",
                                  container: "px-4",
                                }}
                              />
                            </Show>
                          </Match>
                          <Match when={true}>
                            <div class="h-full px-4 pb-30 flex flex-col items-center justify-center text-center gap-6">
                              <Mark class="w-14 opacity-10" />
                              <div class="text-14-regular text-text-weak max-w-56">
                                {language.t("session.review.empty")}
                              </div>
                            </div>
                          </Match>
                        </Switch>
                      </div>
                    }
                  >
                    <div class="relative w-full h-full min-w-0">
                      {/* Opacity only: `all` also animated the bottom edge,
                          which tracks the dock, so the button slid across the
                          screen whenever the composer came or went. */}
                      <div
                        class="absolute left-1/2 -translate-x-1/2 bottom-(--prompt-height) z-[60] pointer-events-none transition-opacity duration-200 ease-out"
                        classList={{
                          "opacity-100 translate-y-0 scale-100": !following(),
                          "opacity-0 translate-y-2 scale-95 pointer-events-none": !!following(),
                        }}
                      >
                        <button
                          class="pointer-events-auto size-(--control-height) flex items-center justify-center rounded-full glass-medium border border-border-base text-text-base hover:bg-background-stronger transition-colors"
                          onClick={resumeScroll}
                          {...preserveFocus()}
                        >
                          <Icon name="arrow-down-to-line" />
                        </button>
                      </div>
                      <div
                        ref={setScrollRef}
                        onWheel={(e) => {
                          const root = e.currentTarget
                          const target = e.target instanceof Element ? e.target : undefined
                          const nested = target?.closest("[data-scrollable]")
                          if (!nested || nested === root) {
                            markScrollGesture(root)
                            return
                          }

                          if (!(nested instanceof HTMLElement)) {
                            markScrollGesture(root)
                            return
                          }

                          const max = nested.scrollHeight - nested.clientHeight
                          if (max <= 1) {
                            markScrollGesture(root)
                            return
                          }

                          const delta =
                            e.deltaMode === 1
                              ? e.deltaY * 40
                              : e.deltaMode === 2
                                ? e.deltaY * root.clientHeight
                                : e.deltaY
                          if (!delta) return

                          if (delta < 0) {
                            if (nested.scrollTop + delta <= 0) markScrollGesture(root)
                            return
                          }

                          const remaining = max - nested.scrollTop
                          if (delta > remaining) markScrollGesture(root)
                        }}
                        onTouchStart={(e) => {
                          touchGesture = e.touches[0]?.clientY
                        }}
                        onTouchMove={(e) => {
                          const next = e.touches[0]?.clientY
                          const prev = touchGesture
                          touchGesture = next
                          if (next === undefined || prev === undefined) return

                          const delta = prev - next
                          if (!delta) return

                          const root = e.currentTarget
                          const target = e.target instanceof Element ? e.target : undefined
                          const nested = target?.closest("[data-scrollable]")
                          if (!nested || nested === root) {
                            markScrollGesture(root)
                            return
                          }

                          if (!(nested instanceof HTMLElement)) {
                            markScrollGesture(root)
                            return
                          }

                          const max = nested.scrollHeight - nested.clientHeight
                          if (max <= 1) {
                            markScrollGesture(root)
                            return
                          }

                          if (delta < 0) {
                            if (nested.scrollTop + delta <= 0) markScrollGesture(root)
                            return
                          }

                          const remaining = max - nested.scrollTop
                          if (delta > remaining) markScrollGesture(root)
                        }}
                        onTouchEnd={() => {
                          touchGesture = undefined
                        }}
                        onTouchCancel={() => {
                          touchGesture = undefined
                        }}
                        onPointerDown={(e) => {
                          if (e.target !== e.currentTarget) return
                          markScrollGesture(e.currentTarget)
                        }}
                        onScroll={(e) => {
                          // Keep the pre-toggle tail snapshot current on EVERY
                          // scroll (gesture or programmatic pin), so the reader
                          // re-pin knows we were at the bottom before the reflow.
                          tailVisible = atBottom(e.currentTarget)
                          // Only a user gesture (wheel/touch/scrollbar/keys —
                          // tracked by markScrollGesture) may change follow
                          // state: away from the bottom unfollows, back to it
                          // refollows. Programmatic scrolls (our pins, virtua's
                          // jump compensation, smooth jumps) never do — they
                          // set following explicitly at their call sites.
                          // `settling` overrides the gesture window: while our
                          // own rAF loop drives the scroller, every event here
                          // is ours no matter how recently the user scrolled.
                          // Without this, momentum kept the window alive into
                          // the settle, the loop's mid-flight (not-yet-bottom)
                          // frames read as "user scrolled away", following went
                          // false, and the loop aborted short of the tail.
                          if (settling) {
                            // Ours and still climbing — nothing to decide.
                          } else if (hasScrollGesture()) {
                            setFollowing(atBottom(e.currentTarget))
                            // Keep the gesture window alive across a long drag
                            // or momentum scroll (each event within the window
                            // extends it); programmatic scrolls arriving after
                            // it lapses stay inert.
                            markScrollGesture(e.currentTarget)
                          } else if (following() && !atBottom(e.currentTarget)) {
                            // A NON-gesture scroll knocked us off the bottom while
                            // following. This is virtua re-applying an eagerly
                            // captured offset on a size change (dock/title reflow
                            // on a reader toggle, async content) — overflow-anchor is
                            // off, so nothing else corrects it. Re-pin so following
                            // keeps meaning "glued to the tail".
                            pinToBottom()
                          }
                          // The scroll-spy (updates the active message from
                          // whatever prompt sits at the viewport top) must run
                          // ONLY for user gestures. A programmatic scroll from
                          // keyboard nav (alt+9/alt+0 -> scrollToMessage) already
                          // set the exact target; letting the spy re-derive it
                          // from the landing offset overwrites that anchor with a
                          // neighbor, so the next step counts from the wrong
                          // message. Same gesture guard the follow logic uses.
                          if (wide() && !settling && hasScrollGesture()) scheduleScrollSpy(e.currentTarget)
                        }}
                        class="relative min-w-0 w-full h-full overflow-y-auto session-scroller"
                        data-reader-sticky={cleanRead() ? "" : undefined}
                        style={{
                          "--session-title-height":
                            cleanRead() || !(info()?.title || info()?.parentID) ? "0px" : "var(--control-height)",
                        }}
                      >
                        <Show when={(info()?.title || info()?.parentID) && !cleanRead()}>
                          <div
                            classList={{
                              "sticky top-0 z-30 bg-background-stronger": true,
                              "w-full": true,
                              "px-4 panel-wide:px-0": true,
                              "panel-wide:max-w-[95%] panel-wide:mx-auto": centered(),
                            }}
                          >
                            <div class="h-(--control-height) flex items-center gap-1">
                              <Show when={info()?.parentID}>
                                <Tooltip value={language.t("session.back.subagent")} placement="bottom" gutter={8}>
                                  <IconButton
                                    tabIndex={-1}
                                    icon="arrow-left"
                                    variant="ghost"
                                    onClick={() => {
                                      navigate(`/${params.dir}/session/${info()?.parentID}`)
                                    }}
                                    aria-label={language.t("session.back.subagent")}
                                  />
                                </Tooltip>
                              </Show>
                              <Show when={info()?.title}>
                                <Show
                                  when={renaming()}
                                  fallback={
                                    <div class="group/title flex items-center gap-1 min-w-0">
                                      <Show when={titleWorking()}>
                                        <span class="mix-spinner size-[15px] shrink-0">
                                          <Spinner class="size-[15px]" style={{ color: baseTint() }} />
                                          <For each={overlays()}>
                                            {(tint, index) => (
                                              <Spinner
                                                class="mix-spinner-overlay size-[15px]"
                                                style={{
                                                  "--overlay-tint": tint,
                                                  "animation-delay": busyDelay(index(), overlays().length),
                                                }}
                                              />
                                            )}
                                          </For>
                                        </span>
                                      </Show>
                                      <h1 class="text-14-medium text-text-strong truncate" onDblClick={startRename}>
                                        {info()?.title}
                                      </h1>
                                      <IconButton
                                        tabIndex={-1}
                                        icon="pencil-line"
                                        variant="ghost"
                                        class="opacity-0 group-hover/title:opacity-100 focus-visible:opacity-100 shrink-0"
                                        onClick={startRename}
                                        aria-label={language.t("common.rename")}
                                      />
                                    </div>
                                  }
                                >
                                  <InlineInput
                                    ref={renameRef}
                                    class="text-14-medium text-text-strong min-w-0 max-w-full px-1.5 -mx-1.5"
                                    width={renameWidth()}
                                    value={draft()}
                                    onInput={(event) => {
                                      setDraft(event.currentTarget.value)
                                      measureRename(event.currentTarget.value)
                                    }}
                                    onKeyDown={(event) => {
                                      if (event.key === "Enter") {
                                        event.preventDefault()
                                        void commitRename()
                                        return
                                      }
                                      if (event.key === "Escape") {
                                        event.preventDefault()
                                        setRenaming(false)
                                      }
                                    }}
                                    onBlur={() => setRenaming(false)}
                                  />
                                  <span
                                    ref={renameSizer}
                                    aria-hidden="true"
                                    class="text-14-medium invisible absolute whitespace-pre pointer-events-none"
                                  />
                                </Show>
                              </Show>
                            </div>
                          </div>
                        </Show>

                        <div
                          ref={setContent}
                          role="log"
                          class="flex flex-col gap-4 items-start justify-start"
                          classList={{
                            "w-full": true,
                            "panel-wide:max-w-[95%] panel-wide:mx-auto": centered(),
                            "mt-0.5": centered(),
                            "mt-0": !centered(),
                          }}
                        >
                          <Show when={historyMore()}>
                            <div class="w-full flex justify-center">
                              <Button
                                variant="ghost"
                                size="large"
                                class="text-12-medium opacity-50"
                                disabled={historyLoading()}
                                onClick={() => {
                                  const id = params.id
                                  if (!id) return
                                  sync.session.history.loadMore(id)
                                }}
                              >
                                {historyLoading()
                                  ? language.t("session.messages.loadingEarlier")
                                  : language.t("session.messages.loadEarlier")}
                              </Button>
                            </div>
                          </Show>
                          <Virtualizer
                            ref={setTurnList}
                            scrollRef={scroller}
                            data={visibleUserMessages()}
                            bufferSize={600}
                            // Turns range from ~80px to ~6000px, and a session opens
                            // at the tail, so estimating from whatever is measured
                            // there extrapolates the long final turns across the
                            // whole history. The scroll range then collapses as
                            // earlier turns measure in, dragging the viewport with
                            // it. A fixed hint near the median keeps the range
                            // honest before anything is measured.
                            itemSize={900}
                            // shift only when turns PREPEND (history load-earlier):
                            // it anchors the view by unshifting virtua's size
                            // cache. Left on for appends it slides every cached
                            // height one slot per new turn.
                            shift={prepended().value}
                          >
                            {(message, index) => (
                              <div
                                id={anchor(message.id)}
                                data-message-id={message.id}
                                classList={{
                                  "min-w-0 w-full max-w-full pb-4": true,
                                  // The last turn carries the floating-dock
                                  // clearance so virtua's align:"end" lands the
                                  // message above the dock, not under it.
                                  "!pb-(--prompt-height)": index() === lastIndex(),
                                }}
                              >
                                <SessionTurn
                                  sessionID={params.id!}
                                  messageID={message.id}
                                  lastUserMessageID={lastUserMessage()?.id}
                                  footer={(m) => <MessageFooter message={m} />}
                                  stepsExpanded={stepsExpandedDefault(message.id)}
                                  onStepsExpandedToggle={() => toggleSteps(message.id)}
                                  onJump={() => scrollToMessage(message)}
                                  classes={{
                                    root: "min-w-0 w-full relative",
                                    content: "flex flex-col justify-between !overflow-visible",
                                    container: "w-full px-4 panel-wide:px-0",
                                  }}
                                />
                              </div>
                            )}
                          </Virtualizer>
                        </div>
                      </div>
                    </div>
                  </Show>
                </Show>
              </Match>
              <Match when={true}>
                <NewSessionView
                  worktree={newSessionWorktree()}
                  onWorktreeChange={(value) => {
                    if (value === "create") {
                      setStore("newSessionWorktree", value)
                      return
                    }

                    setStore("newSessionWorktree", "main")

                    const target = value === "main" ? sync.project?.worktree : value
                    if (!target) return
                    if (target === sync.data.path.directory) return
                    layout.projects.open(target)
                    navigate(`/${base64Encode(target)}/session`)
                  }}
                />
              </Match>
            </Switch>
          </div>

          {/* Everything below the transcript lives in this one column, so what
              is on screen stacks by layout rather than by each part measuring
              the parts beneath it. The transcript clears the column's whole
              height; nothing inside needs to know that height. */}
          <div
            ref={(el) => (promptDock = el)}
            data-slot="prompt-dock"
            classList={{
              // The max-height + min-h-0 bound the dock to the viewport instead
              // of letting it grow upward without limit. Without a bound, nothing
              // inside can know how much room it has, which is why the question
              // panel used to guess with a hardcoded max-height. With the chain
              // bounded, its inner scroller resolves a real height and engages.
              // The titlebar is reserved from the ceiling so an upward-growing
              // child (the slash/at popover) stops below the sticky title bar
              // rather than sliding behind it.
              // The column owns every gap around and between its children, so
              // nothing inside adds its own and stacks two spacings into one
              // edge. py + gap are the single source: 8px above, between, and
              // below, whatever the column happens to hold.
              "absolute inset-x-0 bottom-0 max-h-[calc(100%-var(--titlebar-height))] min-h-0 py-2 gap-2 flex flex-col justify-end items-center z-50 px-4 panel-wide:px-0 pointer-events-none": true,
              // The mobile Changes tab hides the dock outright.
              hidden: reviewReplacesTranscript(),
            }}
          >
            {/* The busy cue outlives the composer: reader hides the one below
                and a running turn must still say so. */}
            <Show when={titleWorking()}>
              <div
                data-slot="busy-bar-dock"
                classList={{
                  "w-full pointer-events-none": true,
                  "panel-wide:max-w-[95%] panel-wide:mx-auto": centered(),
                }}
              >
                <div class="w-full px-3">
                  <div class="busy-bar-track">
                    <div class="busy-bar" style={{ "--stream-accent": baseTint() }}>
                      <span class="busy-bar-fill" />
                      <For each={overlays()}>
                        {(tint, index) => (
                          <span
                            class="busy-bar-fill busy-bar-fill-overlay"
                            style={{
                              "--overlay-tint": tint,
                              "animation-delay": `0s, ${busyDelay(index(), overlays().length)}`,
                            }}
                          />
                        )}
                      </For>
                    </div>
                  </div>
                </div>
              </div>
            </Show>
            {/* flex column + min-h-0 so the constraint from the bounded dock
                reaches the question panel. A flex item's automatic minimum size
                is content-based, so without min-h-0 at EVERY level this column
                refuses to shrink below its content and the panel's inner
                scroller never resolves a height to scroll within. */}
            <div
              ref={(el) => (promptInner = el)}
              classList={{
                "w-full pointer-events-auto flex flex-col min-h-0": true,
                "panel-wide:max-w-[95%] panel-wide:mx-auto": centered(),
                // display:none, not a transform: the column below must collapse
                // so the busy bar above it drops to the screen edge, rather than
                // hovering where the composer used to be.
                hidden: readerDocked(),
              }}
              inert={readerDocked()}
            >
              <Show when={revertMessageID()}>
                <button
                  type="button"
                  class="mb-3 w-full rounded-[14px] border border-border-weak-base glass-dense px-4 py-2 text-left hover:bg-background-element"
                  onClick={() => command.trigger("session.redo")}
                >
                  <div class="text-13-regular text-text-base">
                    {language.t(revertedCount() === 1 ? "session.revert.count.one" : "session.revert.count.other", {
                      count: revertedCount(),
                    })}
                  </div>
                  <div class="text-11-regular text-text-weak">
                    {language.t("session.revert.restore", { keybind: command.keybind("session.redo") })}
                  </div>
                </button>
              </Show>

              <QuestionPanel onClose={() => command.trigger("prompt.focus")} />

              <Show when={request()} keyed>
                {(perm) => (
                  <div data-component="tool-part-wrapper" data-permission="true" class="mb-3">
                    <TranscriptCard
                      icon="checklist"
                      locked
                      defaultOpen
                      trigger={{
                        title: language.t("notification.permission.title"),
                        subtitle:
                          perm.permission === "doom_loop"
                            ? language.t("settings.permissions.tool.doom_loop.title")
                            : perm.permission,
                      }}
                    >
                      <Show when={perm.patterns.length > 0}>
                        <div class="flex flex-col gap-1 py-2 px-3 max-h-40 overflow-y-auto no-scrollbar">
                          <For each={perm.patterns}>
                            {(pattern) => <code class="text-12-regular text-text-base break-all">{pattern}</code>}
                          </For>
                        </div>
                      </Show>
                      <Show when={perm.permission === "doom_loop"}>
                        <div class="text-12-regular text-text-weak pb-2 px-3">
                          {language.t("settings.permissions.tool.doom_loop.description")}
                        </div>
                      </Show>
                    </TranscriptCard>
                    <div data-component="permission-prompt">
                      <div data-slot="permission-actions">
                        <Button variant="ghost" size="small" onClick={() => decide("reject")}>
                          {language.t("ui.permission.deny")}
                        </Button>
                        <Button variant="secondary" size="small" onClick={() => decide("always")}>
                          {language.t("ui.permission.allowAlways")}
                        </Button>
                        <Button variant="primary" size="small" onClick={() => decide("once")}>
                          {language.t("ui.permission.allowOnce")}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </Show>

              {/* display:none, not a transform: a translated composer keeps its
                  box, so the dock could not shrink around a question holding it
                  on screen. Hidden rather than unmounted, so the editor keeps
                  its draft and the dock keeps its size probe. */}
              <div
                data-slot="composer"
                class="w-full min-h-0 flex flex-col"
                classList={{ hidden: reader() && !composerWanted() }}
                inert={reader() && !composerWanted()}
              >
                <Show
                  when={prompt.ready()}
                  fallback={
                    <div class="w-full min-h-32 panel-wide:min-h-40 rounded-md border border-border-weak-base bg-background-base/50 px-4 py-3 text-text-weak whitespace-pre-wrap pointer-events-none">
                      {handoff.prompt || language.t("prompt.loading")}
                    </div>
                  }
                >
                  <PromptInput
                    ref={(el) => {
                      inputRef = el
                    }}
                    newSessionWorktree={newSessionWorktree()}
                    onNewSessionWorktreeReset={() => setStore("newSessionWorktree", "main")}
                    onSubmit={onSubmit}
                  />
                </Show>
              </div>
            </div>
          </div>

          <Show when={wide() && layout.fileTree.opened()}>
            <ResizeHandle
              direction="horizontal"
              size={layout.session.width()}
              min={450}
              max={window.innerWidth * 0.45}
              onResize={layout.session.resize}
            />
          </Show>
        </div>

        {/* Sits beside the transcript when there is room for both. Contained so
            a streamed delta next door cannot relayout the diff, the more
            expensive of the two subtrees. */}
        <Show when={wide() && layout.fileTree.opened()}>
          <aside
            id="review-panel"
            aria-label={language.t("session.panel.reviewAndFiles")}
            class="relative flex-1 min-w-0 h-full border-l border-border-weak-base flex contain-content"
          >
            <div class="flex-1 min-w-0 h-full">
              <Show
                when={fileTreeTab() === "changes"}
                fallback={
                  <DragDropProvider
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                    onDragOver={handleDragOver}
                    collisionDetector={closestCenter}
                  >
                    <DragDropSensors />
                    <ConstrainDragYAxis />
                    <Tabs value={activeTab()} onChange={openTab}>
                      <div class="sticky top-0 shrink-0 flex">
                        <Tabs.List
                          ref={(el: HTMLDivElement) => {
                            let scrollTimeout: number | undefined
                            let prevScrollWidth = el.scrollWidth
                            let prevContextOpen = contextOpen()

                            const handler = () => {
                              if (scrollTimeout !== undefined) clearTimeout(scrollTimeout)
                              scrollTimeout = window.setTimeout(() => {
                                const scrollWidth = el.scrollWidth
                                const clientWidth = el.clientWidth
                                const currentContextOpen = contextOpen()

                                // Only scroll when a tab is added (width increased), not on removal
                                if (scrollWidth > prevScrollWidth) {
                                  if (!prevContextOpen && currentContextOpen) {
                                    // Context tab was opened, scroll to first
                                    el.scrollTo({
                                      left: 0,
                                      behavior: "smooth",
                                    })
                                  } else if (scrollWidth > clientWidth) {
                                    // File tab was added, scroll to rightmost
                                    el.scrollTo({
                                      left: scrollWidth - clientWidth,
                                      behavior: "smooth",
                                    })
                                  }
                                }
                                // When width decreases (tab removed), don't scroll - let browser handle it naturally

                                prevScrollWidth = scrollWidth
                                prevContextOpen = currentContextOpen
                              }, 0)
                            }

                            const wheelHandler = (e: WheelEvent) => {
                              // Enable horizontal scrolling with mouse wheel
                              if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                                el.scrollLeft += e.deltaY > 0 ? 50 : -50
                                e.preventDefault()
                              }
                            }

                            el.addEventListener("wheel", wheelHandler, { passive: false })

                            const observer = new MutationObserver(handler)
                            observer.observe(el, { childList: true })

                            onCleanup(() => {
                              el.removeEventListener("wheel", wheelHandler)
                              observer.disconnect()
                              if (scrollTimeout !== undefined) clearTimeout(scrollTimeout)
                            })
                          }}
                        >
                          <Show when={contextOpen()}>
                            <Tabs.Trigger
                              value="context"
                              closeButton={
                                <Tooltip value={language.t("common.closeTab")} placement="bottom">
                                  <IconButton
                                    icon="close-small"
                                    variant="ghost"
                                    class="size-(--control-height)"
                                    onClick={() => tabs().close("context")}
                                    aria-label={language.t("common.closeTab")}
                                  />
                                </Tooltip>
                              }
                              hideCloseButton
                              onMiddleClick={() => tabs().close("context")}
                            >
                              <div class="flex items-center gap-2">
                                <SessionContextUsage variant="indicator" />
                                <div>{language.t("session.tab.context")}</div>
                              </div>
                            </Tabs.Trigger>
                          </Show>
                          <SortableProvider ids={openedTabs()}>
                            <For each={openedTabs()}>
                              {(tab) => <SortableTab tab={tab} onTabClose={tabs().close} />}
                            </For>
                          </SortableProvider>
                          <StickyAddButton>
                            <TooltipKeybind
                              title={language.t("command.file.open")}
                              keybind={command.keybind("file.open")}
                              class="flex items-center"
                            >
                              <IconButton
                                icon="plus-small"
                                variant="ghost"
                                iconSize="large"
                                onClick={() =>
                                  dialog.show(() => <DialogSelectFile mode="files" onOpenFile={() => showAllFiles()} />)
                                }
                                aria-label={language.t("command.file.open")}
                              />
                            </TooltipKeybind>
                          </StickyAddButton>
                        </Tabs.List>
                      </div>

                      <Tabs.Content value="empty" class="flex flex-col h-full overflow-hidden contain-strict">
                        <Show when={activeTab() === "empty"}>
                          <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                            <div class="h-full px-6 pb-42 flex flex-col items-center justify-center text-center gap-6">
                              <Mark class="w-14 opacity-10" />
                              <div class="text-14-regular text-text-weak max-w-56">
                                {language.t("session.files.selectToOpen")}
                              </div>
                            </div>
                          </div>
                        </Show>
                      </Tabs.Content>

                      <Show when={contextOpen()}>
                        <Tabs.Content value="context" class="flex flex-col h-full overflow-hidden contain-strict">
                          <Show when={activeTab() === "context"}>
                            <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                              <SessionContextTab
                                messages={messages}
                                visibleUserMessages={visibleUserMessages}
                                view={view}
                                info={info}
                              />
                            </div>
                          </Show>
                        </Tabs.Content>
                      </Show>

                      <For each={openedTabs()}>
                        {(tab) => {
                          let scroll: HTMLDivElement | undefined
                          let scrollFrame: number | undefined
                          let pending: { x: number; y: number } | undefined
                          let codeScroll: HTMLElement[] = []

                          const path = createMemo(() => file.pathFromTab(tab))
                          const state = createMemo(() => {
                            const p = path()
                            if (!p) return
                            return file.get(p)
                          })

                          // Modified files render as a diff (GitHub-style) by
                          // default, with a toggle to the raw file. Reuses the
                          // same per-file diff data as the review panel.
                          const diff = createMemo(() => {
                            const p = path()
                            if (!p) return
                            return diffs().find((d) => d.file === p)
                          })
                          const isModified = () => diff() !== undefined
                          const [viewMode, setViewMode] = createSignal<"diff" | "raw">("diff")
                          const showDiff = () => isModified() && viewMode() === "diff"
                          const diffReady = () =>
                            typeof diff()?.before === "string" || typeof diff()?.after === "string"

                          // Lazily fetch this file's before/after the first time
                          // its diff view is shown (dedup + cache in diffFile).
                          createEffect(() => {
                            if (!showDiff()) return
                            if (diffReady()) return
                            const id = params.id
                            const p = path()
                            if (!id || !p) return
                            void sync.session.diffFile(id, p)
                          })

                          const contents = createMemo(() => state()?.content?.content ?? "")
                          const cacheKey = createMemo(() => checksum(contents()))
                          const isImage = createMemo(() => {
                            const c = state()?.content
                            return (
                              c?.encoding === "base64" &&
                              c?.mimeType?.startsWith("image/") &&
                              c?.mimeType !== "image/svg+xml"
                            )
                          })
                          const isSvg = createMemo(() => {
                            const c = state()?.content
                            return c?.mimeType === "image/svg+xml"
                          })
                          const isBinary = createMemo(() => state()?.content?.type === "binary")
                          const svgContent = createMemo(() => {
                            if (!isSvg()) return
                            const c = state()?.content
                            if (!c) return
                            if (c.encoding !== "base64") return c.content
                            return decode64(c.content)
                          })

                          const svgDecodeFailed = createMemo(() => {
                            if (!isSvg()) return false
                            const c = state()?.content
                            if (!c) return false
                            if (c.encoding !== "base64") return false
                            return svgContent() === undefined
                          })

                          const svgToast = { shown: false }
                          createEffect(() => {
                            if (!svgDecodeFailed()) return
                            if (svgToast.shown) return
                            svgToast.shown = true
                            showToast({
                              variant: "error",
                              title: language.t("toast.file.loadFailed.title"),
                              description: "Invalid base64 content.",
                            })
                          })
                          const svgPreviewUrl = createMemo(() => {
                            if (!isSvg()) return
                            const c = state()?.content
                            if (!c) return
                            if (c.encoding === "base64") return `data:image/svg+xml;base64,${c.content}`
                            return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(c.content)}`
                          })
                          const imageDataUrl = createMemo(() => {
                            if (!isImage()) return
                            const c = state()?.content
                            return `data:${c?.mimeType};base64,${c?.content}`
                          })
                          const selectedLines = createMemo(() => {
                            const p = path()
                            if (!p) return null
                            if (file.ready()) return file.selectedLines(p) ?? null
                            return handoff.files[p] ?? null
                          })

                          let wrap: HTMLDivElement | undefined

                          const fileComments = createMemo(() => {
                            const p = path()
                            if (!p) return []
                            return comments.list(p)
                          })

                          const commentedLines = createMemo(() => fileComments().map((comment) => comment.selection))

                          const [note, setNote] = createStore({
                            openedComment: null as string | null,
                            commenting: null as SelectedLineRange | null,
                            draft: "",
                            positions: {} as Record<string, number>,
                            draftTop: undefined as number | undefined,
                          })

                          const openedComment = () => note.openedComment
                          const setOpenedComment = (
                            value:
                              | typeof note.openedComment
                              | ((value: typeof note.openedComment) => typeof note.openedComment),
                          ) => setNote("openedComment", value)

                          const commenting = () => note.commenting
                          const setCommenting = (
                            value: typeof note.commenting | ((value: typeof note.commenting) => typeof note.commenting),
                          ) => setNote("commenting", value)

                          const draft = () => note.draft
                          const setDraft = (
                            value: typeof note.draft | ((value: typeof note.draft) => typeof note.draft),
                          ) => setNote("draft", value)

                          const positions = () => note.positions
                          const setPositions = (
                            value: typeof note.positions | ((value: typeof note.positions) => typeof note.positions),
                          ) => setNote("positions", value)

                          const draftTop = () => note.draftTop
                          const setDraftTop = (
                            value: typeof note.draftTop | ((value: typeof note.draftTop) => typeof note.draftTop),
                          ) => setNote("draftTop", value)

                          const commentLabel = (range: SelectedLineRange) => {
                            const start = Math.min(range.start, range.end)
                            const end = Math.max(range.start, range.end)
                            if (start === end) return `line ${start}`
                            return `lines ${start}-${end}`
                          }

                          const getRoot = () => {
                            const el = wrap
                            if (!el) return

                            const host = el.querySelector("diffs-container")
                            if (!(host instanceof HTMLElement)) return

                            const root = host.shadowRoot
                            if (!root) return

                            return root
                          }

                          const markerTop = (wrapper: HTMLElement, marker: HTMLElement) => {
                            const wrapperRect = wrapper.getBoundingClientRect()
                            const rect = marker.getBoundingClientRect()
                            return rect.top - wrapperRect.top + Math.max(0, (rect.height - 20) / 2)
                          }

                          const updateComments = () => {
                            const el = wrap
                            const root = getRoot()
                            if (!el || !root) {
                              setPositions({})
                              setDraftTop(undefined)
                              return
                            }

                            const next: Record<string, number> = {}
                            for (const comment of fileComments()) {
                              const marker = findMarker(root, comment.selection)
                              if (!marker) continue
                              next[comment.id] = markerTop(el, marker)
                            }

                            setPositions(next)

                            const range = commenting()
                            if (!range) {
                              setDraftTop(undefined)
                              return
                            }

                            const marker = findMarker(root, range)
                            if (!marker) {
                              setDraftTop(undefined)
                              return
                            }

                            setDraftTop(markerTop(el, marker))
                          }

                          const scheduleComments = () => {
                            requestAnimationFrame(updateComments)
                          }

                          createEffect(() => {
                            fileComments()
                            scheduleComments()
                          })

                          createEffect(() => {
                            const range = commenting()
                            scheduleComments()
                            if (!range) return
                            setDraft("")
                          })

                          createEffect(() => {
                            const focus = comments.focus()
                            const p = path()
                            if (!focus || !p) return
                            if (focus.file !== p) return
                            if (activeTab() !== tab) return

                            const target = fileComments().find((comment) => comment.id === focus.id)
                            if (!target) return

                            setOpenedComment(target.id)
                            setCommenting(null)
                            file.setSelectedLines(p, target.selection)
                            requestAnimationFrame(() => comments.clearFocus())
                          })

                          // Dismiss a draft comment without submitting: close the
                          // editor AND clear the drag selection so the highlighted
                          // lines do not linger after clicking away.
                          const dismissComment = () => {
                            setCommenting(null)
                            const p = path()
                            if (p) file.setSelectedLines(p, null)
                          }

                          // Shared shell for both the raw code viewer and the
                          // diff viewer. Both mount a `diffs-container` shadow
                          // root, so the comment overlay/anchor machinery below
                          // is identical; only the inner renderer differs.
                          const renderViewer = (inner: JSX.Element, wrapperClass: string) => (
                            <div
                              ref={(el) => {
                                wrap = el
                                scheduleComments()
                              }}
                              class={`relative overflow-hidden ${wrapperClass}`}
                            >
                              {inner}
                              <For each={fileComments()}>
                                {(comment) => (
                                  <LineCommentView
                                    id={comment.id}
                                    top={positions()[comment.id]}
                                    open={openedComment() === comment.id}
                                    comment={comment.comment}
                                    selection={commentLabel(comment.selection)}
                                    onMouseEnter={() => {
                                      const p = path()
                                      if (!p) return
                                      file.setSelectedLines(p, comment.selection)
                                    }}
                                    onClick={() => {
                                      const p = path()
                                      if (!p) return
                                      setCommenting(null)
                                      setOpenedComment((current) => (current === comment.id ? null : comment.id))
                                      file.setSelectedLines(p, comment.selection)
                                    }}
                                    onOpenChange={(open) => {
                                      if (!open && openedComment() === comment.id) setOpenedComment(null)
                                    }}
                                  />
                                )}
                              </For>
                              <Show when={commenting()}>
                                {(range) => (
                                  <Show when={draftTop() !== undefined}>
                                    <LineCommentEditor
                                      top={draftTop()}
                                      value={draft()}
                                      selection={commentLabel(range())}
                                      onInput={(value) => setDraft(value)}
                                      onCancel={dismissComment}
                                      onSubmit={(value) => {
                                        const p = path()
                                        if (!p) return
                                        addCommentToContext({
                                          file: p,
                                          selection: range(),
                                          comment: value,
                                          origin: "file",
                                        })
                                        setCommenting(null)
                                      }}
                                    />
                                  </Show>
                                )}
                              </Show>
                            </div>
                          )

                          const onLineSelected = (range: SelectedLineRange | null) => {
                            const p = path()
                            if (!p) return
                            file.setSelectedLines(p, range)
                            if (!range) setCommenting(null)
                          }
                          const onLineSelectionEnd = (range: SelectedLineRange | null) => {
                            if (!range) {
                              setCommenting(null)
                              return
                            }
                            setOpenedComment(null)
                            setCommenting(range)
                          }
                          const onViewerRendered = () => {
                            requestAnimationFrame(restoreScroll)
                            requestAnimationFrame(scheduleComments)
                          }

                          const renderCode = (source: string, wrapperClass: string) =>
                            renderViewer(
                              <Dynamic
                                component={codeComponent}
                                file={{ name: path() ?? "", contents: source, cacheKey: cacheKey() }}
                                enableLineSelection
                                selectedLines={selectedLines()}
                                commentedLines={commentedLines()}
                                onRendered={onViewerRendered}
                                onLineSelected={onLineSelected}
                                onLineSelectionEnd={onLineSelectionEnd}
                                overflow="scroll"
                                class="select-text"
                              />,
                              wrapperClass,
                            )

                          // Same shell as renderCode but drives the pierre diff
                          // renderer with this file's before/after.
                          const renderDiff = (wrapperClass: string) =>
                            renderViewer(
                              <Dynamic
                                component={diffComponent}
                                before={{ name: path() ?? "", contents: diff()?.before ?? "" }}
                                after={{ name: path() ?? "", contents: diff()?.after ?? "" }}
                                diffStyle={layout.review.diffStyle()}
                                enableLineSelection
                                selectedLines={selectedLines()}
                                commentedLines={commentedLines()}
                                onRendered={onViewerRendered}
                                onLineSelected={onLineSelected}
                                onLineSelectionEnd={onLineSelectionEnd}
                              />,
                              wrapperClass,
                            )

                          const getCodeScroll = () => {
                            const el = scroll
                            if (!el) return []

                            const host = el.querySelector("diffs-container")
                            if (!(host instanceof HTMLElement)) return []

                            const root = host.shadowRoot
                            if (!root) return []

                            return Array.from(root.querySelectorAll("[data-code]")).filter(
                              (node): node is HTMLElement => node instanceof HTMLElement && node.clientWidth > 0,
                            )
                          }

                          const queueScrollUpdate = (next: { x: number; y: number }) => {
                            pending = next
                            if (scrollFrame !== undefined) return

                            scrollFrame = requestAnimationFrame(() => {
                              scrollFrame = undefined

                              const next = pending
                              pending = undefined
                              if (!next) return

                              view().setScroll(tab, next)
                            })
                          }

                          const handleCodeScroll = (event: Event) => {
                            const el = scroll
                            if (!el) return

                            const target = event.currentTarget
                            if (!(target instanceof HTMLElement)) return

                            queueScrollUpdate({
                              x: target.scrollLeft,
                              y: el.scrollTop,
                            })
                          }

                          const syncCodeScroll = () => {
                            const next = getCodeScroll()
                            if (next.length === codeScroll.length && next.every((el, i) => el === codeScroll[i])) return

                            for (const item of codeScroll) {
                              item.removeEventListener("scroll", handleCodeScroll)
                            }

                            codeScroll = next

                            for (const item of codeScroll) {
                              item.addEventListener("scroll", handleCodeScroll)
                            }
                          }

                          const restoreScroll = () => {
                            const el = scroll
                            if (!el) return

                            const s = view()?.scroll(tab)
                            if (!s) return

                            syncCodeScroll()

                            if (codeScroll.length > 0) {
                              for (const item of codeScroll) {
                                if (item.scrollLeft !== s.x) item.scrollLeft = s.x
                              }
                            }

                            if (el.scrollTop !== s.y) el.scrollTop = s.y

                            if (codeScroll.length > 0) return

                            if (el.scrollLeft !== s.x) el.scrollLeft = s.x
                          }

                          const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
                            if (codeScroll.length === 0) syncCodeScroll()

                            queueScrollUpdate({
                              x: codeScroll[0]?.scrollLeft ?? event.currentTarget.scrollLeft,
                              y: event.currentTarget.scrollTop,
                            })
                          }

                          createEffect(
                            on(
                              () => state()?.loaded,
                              (loaded) => {
                                if (!loaded) return
                                requestAnimationFrame(restoreScroll)
                              },
                              { defer: true },
                            ),
                          )

                          createEffect(
                            on(
                              () => file.ready(),
                              (ready) => {
                                if (!ready) return
                                requestAnimationFrame(restoreScroll)
                              },
                              { defer: true },
                            ),
                          )

                          createEffect(
                            on(
                              () => tabs().active() === tab,
                              (active) => {
                                if (!active) return
                                if (!state()?.loaded) return
                                requestAnimationFrame(restoreScroll)
                              },
                            ),
                          )

                          onCleanup(() => {
                            for (const item of codeScroll) {
                              item.removeEventListener("scroll", handleCodeScroll)
                            }

                            if (scrollFrame === undefined) return
                            cancelAnimationFrame(scrollFrame)
                          })

                          return (
                            <Tabs.Content
                              value={tab}
                              class="mt-3 relative"
                              ref={(el: HTMLDivElement) => {
                                scroll = el
                                restoreScroll()
                              }}
                              onScroll={handleScroll}
                            >
                              <Show when={state()?.loaded && isModified()}>
                                <div class="absolute right-4 top-2 z-10">
                                  <RadioGroup
                                    options={["diff", "raw"] as const}
                                    current={viewMode()}
                                    value={(mode) => mode}
                                    label={(mode) => (mode === "diff" ? "Diff" : "Raw")}
                                    onSelect={(mode) => mode && setViewMode(mode)}
                                  />
                                </div>
                              </Show>
                              <Switch>
                                <Match when={state()?.loaded && showDiff() && diffReady()}>{renderDiff("pb-40")}</Match>
                                <Match when={state()?.loaded && isImage()}>
                                  <div class="px-6 py-4 pb-40">
                                    <img
                                      src={imageDataUrl()}
                                      alt={path()}
                                      class="max-w-full"
                                      onLoad={() => requestAnimationFrame(restoreScroll)}
                                    />
                                  </div>
                                </Match>
                                <Match when={state()?.loaded && isSvg()}>
                                  <div class="flex flex-col gap-4 px-6 py-4">
                                    {renderCode(svgContent() ?? "", "")}
                                    <Show when={svgPreviewUrl()}>
                                      <div class="flex justify-center pb-40">
                                        <img src={svgPreviewUrl()} alt={path()} class="max-w-full max-h-96" />
                                      </div>
                                    </Show>
                                  </div>
                                </Match>
                                <Match when={state()?.loaded && isBinary()}>
                                  <div class="h-full px-6 pb-42 flex flex-col items-center justify-center text-center gap-6">
                                    <Mark class="w-14 opacity-10" />
                                    <div class="flex flex-col gap-2 max-w-md">
                                      <div class="text-14-semibold text-text-strong truncate">
                                        {path()?.split("/").pop()}
                                      </div>
                                      <div class="text-14-regular text-text-weak">
                                        {language.t("session.files.binaryContent")}
                                      </div>
                                    </div>
                                  </div>
                                </Match>
                                <Match when={state()?.loaded}>{renderCode(contents(), "pb-40")}</Match>
                                <Match when={state()?.loading}>
                                  <div class="px-6 py-4 text-text-weak">{language.t("common.loading")}...</div>
                                </Match>
                                <Match when={state()?.error}>
                                  {(err) => <div class="px-6 py-4 text-text-weak">{err()}</div>}
                                </Match>
                              </Switch>
                            </Tabs.Content>
                          )
                        }}
                      </For>
                    </Tabs>
                    <DragOverlay>
                      <Show when={store.activeDraggable}>
                        {(tab) => {
                          const path = createMemo(() => file.pathFromTab(tab()))
                          return (
                            <div class="relative px-6 h-(--control-bar) flex items-center bg-background-stronger border-x border-border-weak-base border-b border-b-transparent">
                              <Show when={path()}>{(p) => <FileVisual active path={p()} />}</Show>
                            </div>
                          )
                        }}
                      </Show>
                    </DragOverlay>
                  </DragDropProvider>
                }
              >
                {reviewPanel()}
              </Show>
            </div>

            <Show when={layout.fileTree.opened()}>
              <div
                id="file-tree-panel"
                class="relative shrink-0 h-full"
                style={{ width: `${layout.fileTree.width()}px` }}
              >
                <div class="h-full border-l border-border-weak-base flex flex-col overflow-hidden group/filetree">
                  <Tabs
                    variant="pill"
                    value={fileTreeTab()}
                    onChange={setFileTreeTabValue}
                    class="h-full"
                    data-scope="filetree"
                  >
                    <Tabs.List>
                      <Tabs.Trigger value="changes" class="flex-1" classes={{ button: "w-full" }}>
                        {reviewCount()}{" "}
                        {language.t(reviewCount() === 1 ? "session.review.change.one" : "session.review.change.other")}
                      </Tabs.Trigger>
                      <Tabs.Trigger value="all" class="flex-1" classes={{ button: "w-full" }}>
                        {language.t("session.files.all")}
                      </Tabs.Trigger>
                    </Tabs.List>
                    <Tabs.Content value="changes" class="bg-background-base px-3 py-0">
                      <Switch>
                        <Match when={hasReview()}>
                          <Show
                            when={diffsReady()}
                            fallback={
                              <div class="px-2 py-2 text-12-regular text-text-weak">
                                {language.t("common.loading")}
                                {language.t("common.loading.ellipsis")}
                              </div>
                            }
                          >
                            <FileTree
                              path=""
                              allowed={diffFiles()}
                              kinds={kinds()}
                              draggable={false}
                              active={activeDiff()}
                              onFileClick={(node) => focusReviewDiff(node.path)}
                            />
                          </Show>
                        </Match>
                        <Match when={true}>
                          <div class="mt-8 text-center text-12-regular text-text-weak">
                            {language.t("session.review.noChanges")}
                          </div>
                        </Match>
                      </Switch>
                    </Tabs.Content>
                    <Tabs.Content value="all" class="bg-background-base px-3 py-0">
                      <FileTree
                        path=""
                        modified={diffFiles()}
                        kinds={kinds()}
                        onFileClick={(node) => openTab(file.tab(node.path))}
                      />
                    </Tabs.Content>
                  </Tabs>
                </div>
                <ResizeHandle
                  direction="horizontal"
                  edge="start"
                  size={layout.fileTree.width()}
                  min={200}
                  max={480}
                  collapseThreshold={160}
                  onResize={layout.fileTree.resize}
                  onCollapse={layout.fileTree.close}
                />
              </div>
            </Show>
          </aside>
        </Show>
      </div>

      <Show when={wide() && view().terminal.opened()}>
        <div
          id="terminal-panel"
          role="region"
          aria-label={language.t("terminal.title")}
          class="relative w-full flex flex-col shrink-0 border-t border-border-weak-base contain-content"
          style={{ height: `${layout.terminal.height()}px` }}
        >
          <ResizeHandle
            direction="vertical"
            size={layout.terminal.height()}
            min={100}
            max={window.innerHeight * 0.6}
            collapseThreshold={50}
            onResize={layout.terminal.resize}
            onCollapse={view().terminal.close}
          />
          <Show
            when={terminal.ready()}
            fallback={
              <div class="flex flex-col h-full pointer-events-none">
                <div class="h-(--control-bar) flex items-center gap-2 px-2 border-b border-border-weak-base bg-background-stronger overflow-hidden">
                  <For each={handoff.terminals}>
                    {(title) => (
                      <div class="px-2 py-1 rounded-md bg-surface-base text-14-regular text-text-weak truncate max-w-40">
                        {title}
                      </div>
                    )}
                  </For>
                  <div class="flex-1" />
                  <div class="text-text-weak pr-2">
                    {language.t("common.loading")}
                    {language.t("common.loading.ellipsis")}
                  </div>
                </div>
                <div class="flex-1 flex items-center justify-center text-text-weak">
                  {language.t("terminal.loading")}
                </div>
              </div>
            }
          >
            <DragDropProvider
              onDragStart={handleTerminalDragStart}
              onDragEnd={handleTerminalDragEnd}
              onDragOver={handleTerminalDragOver}
              collisionDetector={closestCenter}
            >
              <DragDropSensors />
              <ConstrainDragYAxis />
              <div class="flex flex-col h-full">
                <Tabs
                  variant="alt"
                  value={terminal.active()}
                  onChange={(id) => {
                    // Only switch tabs if not in the middle of starting edit mode
                    terminal.open(id)
                  }}
                  class="!h-auto !flex-none"
                >
                  <Tabs.List class="h-(--control-bar)">
                    <SortableProvider ids={terminal.all().map((t: LocalPTY) => t.id)}>
                      <For each={terminal.all()}>
                        {(pty) => (
                          <SortableTerminalTab
                            terminal={pty}
                            onClose={() => {
                              view().terminal.close()
                              setUi("autoCreated", false)
                            }}
                          />
                        )}
                      </For>
                    </SortableProvider>
                    <div class="h-full flex items-center justify-center">
                      <TooltipKeybind
                        title={language.t("command.terminal.new")}
                        keybind={command.keybind("terminal.new")}
                        class="flex items-center"
                      >
                        <IconButton
                          icon="plus-small"
                          variant="ghost"
                          iconSize="large"
                          onClick={terminal.new}
                          aria-label={language.t("command.terminal.new")}
                        />
                      </TooltipKeybind>
                    </div>
                  </Tabs.List>
                </Tabs>
                <div class="flex-1 min-h-0 relative">
                  <For each={terminal.all()}>
                    {(pty) => (
                      <div
                        id={`terminal-wrapper-${pty.id}`}
                        class="absolute inset-0"
                        style={{
                          display: terminal.active() === pty.id ? "block" : "none",
                        }}
                      >
                        <Show when={pty.id} keyed>
                          <Terminal
                            pty={pty}
                            onCleanup={terminal.update}
                            onConnectError={() => terminal.clone(pty.id)}
                          />
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </div>
              <DragOverlay>
                <Show when={store.activeTerminalDraggable}>
                  {(draggedId) => {
                    const pty = createMemo(() => terminal.all().find((t: LocalPTY) => t.id === draggedId()))
                    return (
                      <Show when={pty()}>
                        {(t) => (
                          <div class="relative p-1 h-(--control-bar) flex items-center bg-background-stronger text-14-regular">
                            {(() => {
                              const title = t().title
                              const number = t().titleNumber
                              const match = title.match(/^Terminal (\d+)$/)
                              const parsed = match ? Number(match[1]) : undefined
                              const isDefaultTitle =
                                Number.isFinite(number) && number > 0 && Number.isFinite(parsed) && parsed === number

                              if (title && !isDefaultTitle) return title
                              if (Number.isFinite(number) && number > 0)
                                return language.t("terminal.title.numbered", { number })
                              if (title) return title
                              return language.t("terminal.title")
                            })()}
                          </div>
                        )}
                      </Show>
                    )
                  }}
                </Show>
              </DragOverlay>
            </DragDropProvider>
          </Show>
        </div>
      </Show>
    </div>
  )
}
