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
  type JSX,
} from "solid-js"
import { createCoarsePointer, useShell } from "@/utils/mobile"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { Virtualizer, type VirtualizerHandle } from "virtua/solid"
import { Dynamic, Portal } from "solid-js/web"
import { useLocal } from "@/context/local"
import { selectionFromLines, useFile, type FileSelection, type SelectedLineRange } from "@/context/file"
import { diffSnippet, isDeletionOnly, previewLines } from "@/context/diff-snippet"
import { createStore } from "solid-js/store"
import { PromptInput } from "@/components/prompt-input"
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
import { BasicTool } from "@opencode-ai/ui/basic-tool"
import { SessionReview } from "@opencode-ai/ui/session-review"
import { Mark } from "@opencode-ai/ui/logo"
import { Spinner } from "@opencode-ai/ui/spinner"
import { agentColor } from "@/utils/agent"

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
import { DialogOverview } from "@/components/dialog-overview"
import FileTree from "@/components/file-tree"
import { DialogSelectModel } from "@/components/dialog-select-model"
import { DialogSettings } from "@/components/dialog-settings"
import { DialogFork } from "@/components/dialog-fork"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useNavigate, useParams } from "@solidjs/router"
import { UserMessage } from "@opencode-ai/sdk/v2"
import type { FileDiff } from "@opencode-ai/sdk/v2/client"
import { useSDK } from "@/context/sdk"
import { usePrompt } from "@/context/prompt"
import { useStash } from "@/context/stash"
import { DialogStash } from "@/components/dialog-stash"
import { DialogTasks } from "@/components/dialog-tasks"
import { DialogPending } from "@/components/dialog-pending"
import { useComments, type LineComment } from "@/context/comments"
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
  const comments = useComments()
  const permission = usePermission()

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
  const userMessages = createMemo(
    () => messages().filter((m) => m.role === "user") as UserMessage[],
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

  createEffect(
    on(
      () => lastUserMessage()?.id,
      () => {
        const msg = lastUserMessage()
        if (!msg) return
        if (msg.agent) local.agent.set(msg.agent)
        // Model/variant are NOT mirrored here. The switcher is forward-looking
        // and per-tab: current() already falls back to the last message's model
        // when this tab has no pending pick, so no mirror is needed. Calling
        // local.model.set here would create a spurious pending pick and defeat
        // the pending indicator.
      },
    ),
  )

  const [store, setStore] = createStore({
    activeDraggable: undefined as string | undefined,
    activeTerminalDraggable: undefined as string | undefined,
    expanded: {} as Record<string, boolean>,
    messageId: undefined as string | undefined,
    newSessionWorktree: "main",
    promptHeight: 0,
  })

  // The most recent turns render with their steps expanded by default; older
  // turns collapse to keep the transcript's DOM bounded on long sessions. An
  // explicit per-turn toggle (store.expanded) always overrides this default.
  const recentTurns = 3
  const recentTurnIds = createMemo(() => {
    const msgs = visibleUserMessages()
    return new Set(msgs.slice(-recentTurns).map((m) => m.id))
  })
  const stepsExpandedDefault = (messageID: string) => store.expanded[messageID] ?? recentTurnIds().has(messageID)

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
        // off), a new streamed turn must NOT reset their position — otherwise
        // it drags them back to the bottom mid-read.
        if (!following()) return
        if (lastId && prevLastId && lastId > prevLastId) {
          setStore("messageId", undefined)
        }
      },
      { defer: true },
    ),
  )

  // The single busy read for this session: busy = effective (own OR any subtask,
  // full subtree, computed server-side); busySelf = own turn only. No local
  // child scan — the server already rolled the subtree up.
  const busy = createMemo(
    () => sync.data.session_busy[params.id ?? ""] ?? { busy: false, busySelf: false, busyDescendant: false },
  )
  // busy because a subtask runs (own turn may or may not also be running).
  const subtaskBusy = createMemo(() => busy().busyDescendant)
  const titleWorking = createMemo(() => busy().busy)
  const workingTint = createMemo(() => {
    const agent = local.agent.current()
    return agent ? agentColor(agent.name, agent.color) : undefined
  })
  // Shared three-state color table (agent = own turn, task = child-only,
  // agent↔task cross-fade = both). Base tint is the agent color only while the
  // own turn runs; a child-only turn paints the base task-accent. The task
  // overlay cross-fades in ONLY when both run.
  const baseTint = createMemo(() =>
    busy().busySelf ? (workingTint() ?? "var(--icon-interactive-base)") : "var(--box-accent-task)",
  )
  const mixing = createMemo(() => busy().busySelf && busy().busyDescendant)

  createEffect(
    on(
      () => params.id,
      () => {
        setStore("messageId", undefined)
        setStore("expanded", {})
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

  // Companion mode is a per-visit choice, never a default: switching sessions
  // always lands in the normal view.
  createEffect(
    on(
      () => params.id,
      () => layout.companion.exit(),
      { defer: true },
    ),
  )

  createEffect(() => {
    const id = lastUserMessage()?.id
    if (!id) return
    if (busy().busy) setStore("expanded", id, true)
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
      id: "home.open",
      title: language.t("command.home.open"),
      category: language.t("command.category.session"),
      keybind: "alt+h",
      onSelect: () => navigate("/"),
    },
    {
      id: "overview.open",
      title: language.t("command.overview.open"),
      category: language.t("command.category.session"),
      keybind: "mod+k",
      onSelect: () => dialog.show(() => <DialogOverview />),
    },
    {
      id: "overview.attention",
      title: language.t("command.overview.attention"),
      category: language.t("command.category.session"),
      keybind: "ctrl+tab",
      onSelect: () => dialog.show(() => <DialogOverview advance switcher />),
    },
    {
      id: "overview.attention.reverse",
      title: language.t("command.overview.attention.reverse"),
      category: language.t("command.category.session"),
      keybind: "ctrl+shift+tab",
      onSelect: () => dialog.show(() => <DialogOverview switcher />),
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
        setStore("expanded", msg.id, (open: boolean | undefined) => !open)
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
      onSelect: () => dialog.show(() => <DialogSettings initialTab="mcp" />),
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
      keybind: "shift+mod+d",
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
        if (busy().busy) {
          await sdk.client.session.abort({ sessionID }).catch(() => {})
        }
        const revert = info()?.revert?.messageID
        // Find the last user message that's not already reverted
        const message = findLast(userMessages(), (x) => !revert || x.id < revert)
        if (!message) return
        await sdk.client.session.revert({ sessionID, messageID: message.id })
        // Restore the prompt from the reverted message
        const parts = sync.data.part[message.id]
        if (parts) {
          const restored = extractPromptFromParts(parts, { directory: sdk.directory })
          prompt.set(restored)
        }
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
          await sdk.client.session.unrevert({ sessionID })
          prompt.reset()
          // Navigate to the last message (the one that was at the revert point)
          const lastMsg = findLast(userMessages(), (x) => x.id >= revertMessageID)
          setActiveMessage(lastMsg)
          return
        }
        // Partial redo - move forward to next message
        await sdk.client.session.revert({ sessionID, messageID: nextMessage.id })
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
        const model = local.model.current()
        if (!model) {
          showToast({
            title: language.t("toast.model.none.title"),
            description: language.t("toast.model.none.description"),
          })
          return
        }
        await sdk.client.session.summarize({
          sessionID,
          modelID: model.id,
          providerID: model.provider.id,
        })
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
        stash.push(prompt.current(), prompt.context.items())
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
      id: "task.list",
      title: language.t("command.task.list"),
      description: language.t("command.task.list.description"),
      category: language.t("command.category.session"),
      keybind: "alt+a",
      disabled: !params.id,
      onSelect: () => dialog.show(() => <DialogTasks />),
    },
    {
      id: "task.pending",
      title: language.t("command.task.pending"),
      description: language.t("command.task.pending.description"),
      category: language.t("command.category.session"),
      keybind: "alt+x",
      disabled: !params.id,
      onSelect: () => dialog.show(() => <DialogPending />),
    },
    {
      id: "zen.toggle",
      title: language.t("command.zen.toggle"),
      description: language.t("command.zen.toggle.description"),
      category: language.t("command.category.session"),
      keybind: "alt+z",
      onSelect: () => layout.zen.toggle(),
    },
    {
      id: "companion.toggle",
      title: language.t("command.companion.toggle"),
      description: language.t("command.companion.toggle.description"),
      category: language.t("command.category.session"),
      keybind: "alt+c",
      onSelect: () => layout.companion.toggle(),
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

    if (activeElement === inputRef) {
      if (event.key === "Escape") inputRef?.blur()
      return
    }

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

  // Live "is the tail visible" flag, updated on every scroll. The zen-toggle
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
  // whatever triggered it. Like the zen re-pin: a fresh following() read is
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

  const setScrollRef = (el: HTMLDivElement | undefined) => {
    scroller = el
    setScrollerBox(el)
  }

  // virtua owns turn windowing: it keeps only the visible range (+overscan)
  // mounted and props the scroller to full estimated height, so scrollHeight
  // stays honest for the tail-follow/restore logic below. Its handle drives
  // every jump-to-turn (Home/End/deep-link/prev-next) via scrollToIndex, which
  // realizes an unmounted target before scrolling — the DOM getElementById path
  // alone can't reach a turn that isn't rendered.
  const [turnList, setTurnList] = createSignal<VirtualizerHandle | undefined>()
  const turnIndex = (messageID: string) => visibleUserMessages().findIndex((m) => m.id === messageID)

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

  createResizeObserver(
    () => promptDock,
    () => {
      if (!promptDock) return
      // Clearance = the dock's OPAQUE footprint = border-box height minus the
      // pt-12 transparent gradient top (the transcript scrolls under that). The
      // border box includes the dock's bottom padding (which carries the
      // safe-area inset in standalone), so the last card clears the input.
      const padTop = parseFloat(getComputedStyle(promptDock).paddingTop) || 0
      const next = Math.ceil(promptDock.offsetHeight - padTop)
      if (next <= 0 || next === store.promptHeight) return

      setStore("promptHeight", next)
      // On the root element, not the session panel: the dictation overlay
      // portals to <body> and would otherwise inherit nothing to anchor to.
      document.documentElement.style.setProperty("--prompt-height", `${next}px`)

      // A taller dock covers the tail; re-pin if following. The dock grows when
      // the busy bar mounts mid-stream, and the height change propagates through
      // --prompt-height -> last-turn padding -> scrollHeight over SEVERAL frames,
      // not one. A single pinToBottom lands the first frame and then the padding
      // keeps growing, leaving the view short (the busy-session bug). settle each
      // frame until the bottom holds.
      if (following()) settleToBottom()
    },
  )

  // Zen toggling reflows the tail in ways the content ResizeObserver can't
  // catch: the sticky session title (a scroller child, not virtua content)
  // unmounts, the scroller's --session-title-height flips, and the dock swaps
  // height. The scroller runs overflow-anchor:none (virtua needs it to avoid
  // oscillation), so the browser no longer compensates these height changes the
  // way it did before virtua. The tail slides under the dock and stays there.
  //
  // Kick a re-pin from the pre-toggle snapshot (a fresh atBottom() read here is
  // too late, the DOM already reflowed). The single pin lands the first frame;
  // the onScroll re-pin below then keeps the tail glued as the dock/title reflow
  // and virtua's later size-change compensation arrive over subsequent frames.
  createEffect(
    on(
      () => layout.zen.opened(),
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

      // If we have a message hash but the message isn't loaded/rendered yet,
      // don't fall back to "bottom". We'll retry once messages arrive.
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
    if (ui.pendingMessage === targetId) setUi("pendingMessage", undefined)
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

  // Zen toggle-pill. Always visible (this is the only zen control — the dock
  // has no enter button). Rendered through a Portal to <body> so it escapes the
  // app shell's `contain: strict` <main> (which clips fixed descendants).
  // Default anchor sits just above the prompt dock on the right, tracking the
  // dock height. Because the dock collapses to 0 in zen, we hold the last
  // non-zero dock height so the pill stays put across the toggle. Desktop
  // presses toggle (no drag); mobile can drag past a small threshold to switch
  // to explicit viewport left/top coords (in-memory only, resets on reload); a
  // press that never crosses the threshold toggles zen.
  const [dockHeight, setDockHeight] = createSignal(0)
  createEffect(() => {
    if (layout.zen.opened()) return
    const h = store.promptHeight
    if (h > 0) setDockHeight(h)
  })

  // Desktop pill hugs the top-right corner of the visible input box, so it
  // never floats over the input or lands in the centered layout's side gutter.
  // Track that box's viewport rect; the corner anchor is derived from it. In
  // zen the dock height changes but the box keeps its last rect, so the pill
  // stays put. Re-measured on dock resize, zen toggle, file-tree/centering
  // changes, and window resize.
  const [dockRect, setDockRect] = createSignal<{ right: number; top: number } | null>(null)
  const measureDock = () => {
    // Anchor to the input box itself, not promptInner (the dock content column).
    // promptInner stacks the question panel, permission prompt, and busy bar
    // ABOVE the input, so its top edge rises when any of those appear and the
    // pill would ride up with it. In the slim zen dock that also lands the pill
    // on top of the submit/stop button. The input box's top edge is stable.
    // inputRef is the contenteditable, which desktop zen shrinks to flex-1
    // beside the button row; its form wrapper spans the box in both modes.
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
    setDockRect({ right: r.right + (vv?.offsetLeft ?? 0), top: r.top + (vv?.offsetTop ?? 0) })
  }
  createEffect(() => {
    // Depend on the triggers that move the box, then measure post-layout.
    void store.promptHeight
    void layout.zen.opened()
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

  // Sized for a fingertip on every device: the pill floats over content, so it
  // gets the enhanced touch target even under a mouse, and a touch pointer a
  // little more.
  const coarse = createCoarsePointer()
  const pillSize = () => (coarse() ? 56 : 52)
  const PILL_MARGIN = 16
  const DRAG_THRESHOLD = 6
  // Read a safe-area inset (exposed as a CSS var in index.css) as a number, so
  // a dragged pill can't be parked under the status bar / home indicator. 0 in
  // a normal browser.
  const inset = (name: "--sat" | "--sar" | "--sab" | "--sal") =>
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0
  const clampPill = (x: number, y: number) => ({
    x: Math.max(
      PILL_MARGIN + inset("--sal"),
      Math.min(x, window.innerWidth - pillSize() - PILL_MARGIN - inset("--sar")),
    ),
    y: Math.max(
      PILL_MARGIN + inset("--sat"),
      Math.min(y, window.innerHeight - pillSize() - PILL_MARGIN - inset("--sab")),
    ),
  })
  const [drag, setDrag] = createSignal<{ x: number; y: number } | null>(null)
  const [pos, setPos] = createSignal<{ x: number; y: number } | null>(null)
  // Gap between the pill and the input box's top edge. Kept large enough that
  // the pill clears the submit/stop button's tap zone at the box's right edge,
  // so a tap on the pill never lands on the stop button (and vice versa).
  const PILL_GAP = 24
  // Nudge the pill's right edge past the box's right edge into the gutter, so it
  // sits at the true screen corner rather than leaving a gap. Clamped to the
  // viewport so it can't run off-screen.
  const PILL_NUDGE = 12
  // Anchor priority: a mobile drag override wins; otherwise both platforms pin
  // to the input box's top-right corner, hovering just above the top edge.
  // Null only until the first measurement lands.
  const pillCoords = createMemo(() => {
    const dragged = drag() ?? pos()
    if (dragged) return dragged
    const rect = dockRect()
    if (!rect) return null
    const maxX = window.innerWidth - pillSize() - PILL_MARGIN
    return {
      x: Math.min(rect.right - pillSize() + PILL_NUDGE, maxX),
      y: rect.top - pillSize() - PILL_GAP,
    }
  })

  // Pointer events TRACK the drag; they never toggle. The toggle is the click
  // below, so the pill activates like every other control (and stays reachable
  // by keyboard and screen reader). A drag past the threshold suppresses that
  // click, which is what separates "moved the pill" from "tapped the pill".
  let dragged = false
  function startPillDrag(e: PointerEvent) {
    if (wide()) return
    const startX = e.clientX
    const startY = e.clientY
    dragged = false

    const move = (ev: PointerEvent) => {
      if (!dragged && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return
      dragged = true
      setDrag(clampPill(ev.clientX - pillSize() / 2, ev.clientY - pillSize() / 2))
    }
    const up = () => {
      document.removeEventListener("pointermove", move)
      document.removeEventListener("pointerup", up)
      const final = drag()
      setDrag(null)
      if (final) setPos(final)
    }
    document.addEventListener("pointermove", move)
    document.addEventListener("pointerup", up)
  }

  return (
    <div
      class="relative bg-background-base size-full overflow-hidden flex flex-col"
      // Inherited by both permission prompts (the dock's and the in-transcript
      // one), so they carry the same agent tint as the question panel's border.
      style={{ "--permission-accent": workingTint() ?? "var(--icon-interactive-base)" }}
    >
      <SessionHeader />
      {/* Zen toggle: always-visible pill, the only zen control.
          Portaled to <body> so the shell's contain:strict <main> can't clip it.
          Anchored just above the prompt dock on the right by default; the held
          dock height keeps it put across the zen toggle. Mobile can drag it. */}
      <Portal>
        <button
          type="button"
          onPointerDown={startPillDrag}
          onClick={() => {
            // A drag that ended elsewhere still emits a click here; only a tap
            // that stayed put should toggle.
            if (dragged) {
              dragged = false
              return
            }
            layout.zen.toggle()
          }}
          aria-label={layout.zen.opened() ? language.t("zen.exit") : language.t("zen.enter")}
          // wide:, not panel-wide:: the pill portals to <body>, where no
          // ancestor declares a container, so a container variant never
          // matches and the class silently does nothing.
          class="fixed z-[100] flex items-center justify-center rounded-full shadow-md border border-border-weak-base bg-surface-raised-base text-icon-base touch-none select-none cursor-grab active:cursor-grabbing wide:cursor-pointer wide:active:cursor-pointer hover:bg-surface-raised-base-hover"
          classList={{ "transition-none": drag() !== null }}
          style={{
            // Measured top-right corner anchor (both platforms + mobile drag).
            // The right/bottom fallback only applies before the first measure;
            // its safe-area insets keep it clear of the status bar in a PWA.
            ...(pillCoords()
              ? { left: `${pillCoords()!.x}px`, top: `${pillCoords()!.y}px` }
              : {
                  right: `calc(${PILL_MARGIN}px + env(safe-area-inset-right))`,
                  bottom: `calc(${dockHeight() + PILL_MARGIN}px + env(safe-area-inset-bottom))`,
                }),
            width: `${pillSize()}px`,
            height: `${pillSize()}px`,
          }}
        >
          <span class="text-xl leading-none select-none" aria-hidden="true">
            {layout.zen.opened() ? "🌐" : "🧘"}
          </span>
        </button>
      </Portal>
      <div class="flex-1 min-h-0 flex flex-col wide:flex-row">
        {/* Session panel */}
        <div
          classList={{
            "@container/panel relative shrink-0 flex flex-col min-h-0 h-full bg-background-stronger": true,
            "flex-1 pt-0 wide:pt-3": true,
            "wide:flex-none": layout.fileTree.opened(),
          }}
          style={{
            width: wide() && layout.fileTree.opened() ? `${layout.session.width()}px` : "100%",
            // In zen the titlebar stops drawing, so on mobile this panel clears
            // the device's top safe-area inset (status bar) plus a 1rem gap that
            // mirrors the bottom margin. --sat is 0 on desktop, where the WCO
            // strip is already reserved by the titlebar, so it degrades to the gap.
            "padding-top": layout.zen.opened() ? "calc(var(--sat) + 1rem)" : undefined,
          }}
        >
          {/* Companion mode hides the transcript with CSS rather than
              unmounting it: the session stays fully subscribed and the scroll
              position survives, so leaving companion restores the exact view.
              The dock is absolutely bottom-anchored, so it stays put. */}
          <div
            classList={{
              "flex-1 min-h-0 overflow-hidden": true,
              hidden: layout.companion.opened(),
            }}
          >
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
                                  root: "pb-[calc(var(--prompt-height,8rem)+12px)]",
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
                      <div
                        class="absolute left-1/2 -translate-x-1/2 bottom-[calc(var(--prompt-height,8rem)+12px)] z-[60] pointer-events-none transition-all duration-200 ease-out"
                        classList={{
                          "opacity-100 translate-y-0 scale-100": !following(),
                          "opacity-0 translate-y-2 scale-95 pointer-events-none": !!following(),
                        }}
                      >
                        <button
                          class="pointer-events-auto size-8 flex items-center justify-center rounded-full bg-background-base border border-border-base shadow-sm text-text-base hover:bg-background-stronger transition-colors"
                          onClick={resumeScroll}
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
                          // scroll (gesture or programmatic pin), so the zen
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
                            // on a zen toggle, async content) — overflow-anchor is
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
                        style={{
                          "--session-title-height":
                            !layout.zen.opened() && (info()?.title || info()?.parentID)
                              ? wide()
                                ? "28px"
                                : "24px"
                              : "0px",
                        }}
                      >
                        <Show when={!layout.zen.opened() && (info()?.title || info()?.parentID)}>
                          <div
                            classList={{
                              "sticky top-0 z-30 bg-background-stronger": true,
                              "w-full": true,
                              "px-4 panel-wide:px-0": true,
                              "panel-wide:max-w-[95%] panel-wide:mx-auto": centered(),
                            }}
                          >
                            <div class="h-6 panel-wide:h-7 flex items-center gap-1">
                              <Show when={info()?.parentID}>
                                <IconButton
                                  tabIndex={-1}
                                  icon="arrow-left"
                                  variant="ghost"
                                  onClick={() => {
                                    navigate(`/${params.dir}/session/${info()?.parentID}`)
                                  }}
                                  aria-label={language.t("common.goBack")}
                                />
                              </Show>
                              <Show when={info()?.title}>
                                <Show
                                  when={renaming()}
                                  fallback={
                                    <div class="group/title flex items-center gap-1 min-w-0">
                                      <Show when={titleWorking()}>
                                        <span class="mix-spinner size-[15px] shrink-0">
                                          <Spinner class="size-[15px]" style={{ color: baseTint() }} />
                                          <Show when={mixing()}>
                                            <Spinner class="mix-spinner-task size-[15px]" />
                                          </Show>
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
                          class="flex flex-col gap-4 items-start justify-start transition-[margin]"
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
                                  "!pb-[calc(var(--prompt-height,8rem)+12px)] panel-wide:!pb-[calc(var(--prompt-height,10rem)+12px)]":
                                    index() === lastIndex(),
                                }}
                              >
                                <SessionTurn
                                  sessionID={params.id!}
                                  messageID={message.id}
                                  lastUserMessageID={lastUserMessage()?.id}
                                  footer={(m) => <MessageFooter message={m} />}
                                  stepsExpanded={stepsExpandedDefault(message.id)}
                                  onStepsExpandedToggle={() =>
                                    setStore("expanded", message.id, (open: boolean | undefined) => !open)
                                  }
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

          {/* Prompt input — hidden entirely in zen mode (messages only) and on
              the mobile Changes tab, where you're reviewing a diff, not
              composing, so the dock is dead weight over the file list. */}
          <div
            ref={(el) => (promptDock = el)}
            data-slot="prompt-dock"
            classList={{
              // max-h-full + min-h-0 bound the dock to the viewport instead of
              // letting it grow upward without limit. Without a bound, nothing
              // inside can know how much room it has, which is why the question
              // panel used to guess with a hardcoded max-height. With the chain
              // bounded, its inner scroller resolves a real height and engages.
              "absolute inset-x-0 bottom-0 max-h-full min-h-0 pt-12 pb-4 flex flex-col justify-end items-center z-50 px-4 panel-wide:px-0 bg-gradient-to-t from-background-stronger via-background-stronger to-transparent pointer-events-none": true,
              // Zen keeps a slimmed dock (input + attach + submit + question/permission
              // prompts) rather than hiding it, so questions stay answerable in zen.
              // PromptInput drops its own chrome via useLayout().zen. Only the mobile
              // Changes tab hides the dock outright.
              hidden: reviewReplacesTranscript(),
            }}
          >
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
              }}
            >
              <Show when={revertMessageID()}>
                <button
                  type="button"
                  class="mb-3 w-full rounded-md border border-border-weak-base bg-background-base/95 px-4 py-2 text-left hover:bg-background-element"
                  onClick={() => command.trigger("session.redo")}
                >
                  <div class="text-13-regular text-text-base">
                    {language.t("session.revert.count", { count: revertedCount() })}
                  </div>
                  <div class="text-11-regular text-text-weak">
                    {language.t("session.revert.restore", { keybind: command.keybind("session.redo") })}
                  </div>
                </button>
              </Show>

              <QuestionPanel onClose={() => command.trigger("prompt.focus")} />

              {/* Busy-turn bar in the gap between the message boxes and the dock,
                  the busy cue in BOTH modes. The dock's own busy spinner
                  (dock-line1) is suppressed, so this bar is the single indicator.
                  mt-2 matters: the bar is the dock's FIRST child, sitting in the
                  pt-12 transparent gradient zone the transcript scrolls under.
                  The clearance math (offsetHeight - padTop) only reserves space
                  BELOW that zone, so without its own top offset the bar overlays
                  the last box instead of the gap. */}
              <Show when={titleWorking()}>
                <div class="w-full px-3 mt-2 mb-2">
                  <div class="busy-bar-track">
                    <div class="busy-bar" style={{ "--stream-accent": baseTint() }}>
                      <span class="busy-bar-fill" />
                      <Show when={mixing()}>
                        <span class="busy-bar-fill busy-bar-fill-task" />
                      </Show>
                    </div>
                  </div>
                </div>
              </Show>

              <Show when={request()} keyed>
                {(perm) => (
                  <div data-component="tool-part-wrapper" data-permission="true" class="mb-3">
                    <BasicTool
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
                    </BasicTool>
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
                  onSubmit={resumeScroll}
                />
              </Show>
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
                                    class="h-5 w-5"
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
                            <div class="relative px-6 h-12 flex items-center bg-background-stronger border-x border-border-weak-base border-b border-b-transparent">
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
                <div class="h-10 flex items-center gap-2 px-2 border-b border-border-weak-base bg-background-stronger overflow-hidden">
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
                  <Tabs.List class="h-10">
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
                          <div class="relative p-1 h-10 flex items-center bg-background-stronger text-14-regular">
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
