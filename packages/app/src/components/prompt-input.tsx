import { useFilteredList } from "@opencode-ai/ui/hooks"
import {
  createEffect,
  on,
  Component,
  Show,
  For,
  onMount,
  onCleanup,
  Switch,
  Match,
  createMemo,
  createSignal,
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createFocusSignal } from "@solid-primitives/active-element"
import { useLocal } from "@/context/local"
import { useFile, type FileSelection } from "@/context/file"
import {
  ContentPart,
  DEFAULT_PROMPT,
  clonePrompt,
  isPromptEqual,
  Prompt,
  usePrompt,
  ImageAttachmentPart,
  AgentPart,
  FileAttachmentPart,
} from "@/context/prompt"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useNavigate, useParams } from "@solidjs/router"
import { useSync } from "@/context/sync"
import { useComments } from "@/context/comments"
import { useStash } from "@/context/stash"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { agentColor } from "@/utils/agent"
import { busyBase, busyDelay, busyOverlays } from "@opencode-ai/ui/util/busy-tint"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import type { IconName } from "@opencode-ai/ui/icons/provider"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Select } from "@opencode-ai/ui/select"
import { getDirectory, getFilename, getFilenameTruncated } from "@opencode-ai/util/path"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ImagePreview } from "@opencode-ai/ui/image-preview"
import { ModelSelectorPopover } from "@/components/dialog-select-model"
import { DialogSelectModelUnpaid } from "@/components/dialog-select-model-unpaid"
import { DialogSkill } from "@/components/dialog-skill"
import { DialogDock } from "@/components/dialog-dock"
import { useProviders } from "@/hooks/use-providers"
import { useCommand } from "@/context/command"
import { useSettings } from "@/context/settings"
import { compress } from "@/utils/image"
import { Persist, persisted } from "@/utils/persist"
import { Identifier } from "@/utils/id"
import { confirmAbsent } from "@/utils/confirm-absent"
import { createDictation, dictationTarget, registerDictationTarget } from "@/utils/dictation"
import { overlayActive } from "@/utils/overlay"
import { createCoarsePointer, preserveFocus } from "@/utils/mobile"
import { DictationOverlay } from "@/components/dictation-overlay"
import { MicIcon } from "@/components/mic-icon"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { Statusline } from "@/components/statusline"
import { PromptActionBar } from "@/components/prompt-actionbar"
import { usePermission } from "@/context/permission"
import { useQuestion } from "@/context/question"
import { useLanguage } from "@/context/language"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { createOpencodeClient, type Message, type Part } from "@opencode-ai/sdk/v2/client"
import { Binary } from "@opencode-ai/util/binary"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode } from "@opencode-ai/util/encode"

const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"]
const ACCEPTED_FILE_TYPES = [...ACCEPTED_IMAGE_TYPES, "application/pdf"]

type PendingPrompt = {
  abort: AbortController
  cleanup: VoidFunction
}

const pending = new Map<string, PendingPrompt>()

// A prompt still in the send window is held here rather than on the server, so
// stopping it cancels the request instead of the turn it has not started yet.
export function abortTurn(client: ReturnType<typeof createOpencodeClient>, sessionID: string) {
  const queued = pending.get(sessionID)
  if (queued) {
    queued.abort.abort()
    queued.cleanup()
    pending.delete(sessionID)
    return
  }
  void client.session.abortTurn({ sessionID }).catch(() => {})
}

interface PromptInputProps {
  class?: string
  ref?: (el: HTMLDivElement) => void
  newSessionWorktree?: string
  onNewSessionWorktreeReset?: () => void
  onSubmit?: () => void
}

interface SlashCommand {
  id: string
  trigger: string
  title: string
  description?: string
  keybind?: string
  type: "builtin" | "custom"
  source?: "command" | "mcp" | "skill"
}

export const PromptInput: Component<PromptInputProps> = (props) => {
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const globalSync = useGlobalSync()
  const platform = usePlatform()
  const local = useLocal()
  const files = useFile()
  const prompt = usePrompt()
  const commentCount = createMemo(() => prompt.context.items().filter((item) => !!item.comment?.trim()).length)
  const dir = createMemo(() => {
    const home = sync.data.path.home
    return home && sdk.directory.startsWith(home) ? "~" + sdk.directory.slice(home.length) : sdk.directory
  })
  const layout = useLayout()
  // Reader takes the composer off screen entirely, so this slims what remains
  // for the frame in which it is still painted. All other dock chrome
  // (model/agent/variant selectors, the bottom status/action row, the permission
  // auto-accept toggle) is gated behind !reader().
  const reader = () => layout.reader.opened()
  // Companion mode keeps every control (this dock is the only interface on that
  // device) but hands the freed transcript space to the touch targets: double
  // the usual control, with the icons scaled to match. Five of them at that size
  // still fit a 393px-wide phone. Applied at EVERY width, so the mode looks like
  // itself on desktop too.
  const companion = () => layout.companion.opened()
  // The tall writing surface only earns its space when the composer IS the
  // screen. A pending question or permission prompt stacks directly above the
  // dock and is what you're actually answering, so the reserved height stops
  // being a feature and starts squeezing the thing you need to read. The flex
  // chain would now shrink the editor on its own, but yielding outright gives
  // the panel the whole gap rather than making it fight for a share.
  const companionTall = () => companion() && question.pending().length === 0
  const actionButton = () => (companion() ? "size-[calc(var(--control-height)*2)]! px-1" : "px-1")
  // Icon sizes through its WRAPPER: [data-component=icon] is the sized box and
  // the svg inside is width:100% of it, so a class on the svg alone only moves
  // its height and leaves a stretched sliver. Target the wrapper instead. The
  // component's own size prop tops out well below what this button needs.
  const actionIcon = () =>
    companion()
      ? "[&>[data-component=icon]]:!size-(--control-height)"
      : ""
  const comments = useComments()
  const stash = useStash()
  const params = useParams()
  const dialog = useDialog()
  const providers = useProviders()
  const command = useCommand()
  const permission = usePermission()
  const question = useQuestion()
  const language = useLanguage()
  const settings = useSettings()
  let editorRef!: HTMLDivElement
  let fileInputRef!: HTMLInputElement
  let scrollRef!: HTMLDivElement
  let slashPopoverRef!: HTMLDivElement

  const mirror = { input: false }

  const scrollCursorIntoView = () => {
    const container = scrollRef
    const selection = window.getSelection()
    if (!container || !selection || selection.rangeCount === 0) return

    const range = selection.getRangeAt(0)
    if (!editorRef.contains(range.startContainer)) return

    const rect = range.getBoundingClientRect()
    if (!rect.height) return

    const containerRect = container.getBoundingClientRect()
    const top = rect.top - containerRect.top + container.scrollTop
    const bottom = rect.bottom - containerRect.top + container.scrollTop
    const padding = 12

    if (top < container.scrollTop + padding) {
      container.scrollTop = Math.max(0, top - padding)
      return
    }

    if (bottom > container.scrollTop + container.clientHeight - padding) {
      container.scrollTop = bottom - container.clientHeight + padding
    }
  }

  const queueScroll = () => {
    requestAnimationFrame(scrollCursorIntoView)
  }

  const sessionKey = createMemo(() => `${params.dir}${params.id ? "/" + params.id : ""}`)
  const tabs = createMemo(() => layout.tabs(sessionKey))

  const commentInReview = (path: string) => {
    const sessionID = params.id
    if (!sessionID) return false

    const diffs = sync.data.session_diff[sessionID]
    if (!diffs) return false
    return diffs.some((diff) => diff.file === path)
  }

  const openComment = (item: { path: string; commentID?: string; commentOrigin?: "review" | "file" }) => {
    if (!item.commentID) return

    const focus = { file: item.path, id: item.commentID }
    comments.setActive(focus)

    const wantsReview = item.commentOrigin === "review" || (item.commentOrigin !== "file" && commentInReview(item.path))
    if (wantsReview) {
      layout.fileTree.open()
      layout.fileTree.setTab("changes")
      requestAnimationFrame(() => comments.setFocus(focus))
      return
    }

    layout.fileTree.open()
    layout.fileTree.setTab("all")
    const tab = files.tab(item.path)
    tabs().open(tab)
    files.load(item.path)
    requestAnimationFrame(() => comments.setFocus(focus))
  }

  const recent = createMemo(() => {
    const all = tabs().all()
    const active = tabs().active()
    const order = active ? [active, ...all.filter((x) => x !== active)] : all
    const seen = new Set<string>()
    const paths: string[] = []

    for (const tab of order) {
      const path = files.pathFromTab(tab)
      if (!path) continue
      if (seen.has(path)) continue
      seen.add(path)
      paths.push(path)
    }

    return paths
  })
  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  // The single busy read for this session, from the one operative store.
  // working = effective (own OR any subtask, server-rolled full subtree).
  const busy = createMemo(
    () => sync.data.session_busy[params.id ?? ""] ?? { busy: false, busySelf: false, busyDescendant: false },
  )
  // A helper session owing this one a report keeps the indicator up too: work
  // is still coming back, so going dark would say the session is done.
  const working = createMemo(() => busy().busy || busy().busyHelper === true)
  // Something is in the box worth sending — text draft or pending comments.
  const submittable = createMemo(() => prompt.dirty() || commentCount() > 0)
  const workingTint = createMemo(() => {
    const agent = local.agent.current()
    return agent ? agentColor(agent.name, agent.color) : undefined
  })
  const baseTint = createMemo(() => busyBase(busy(), workingTint()))
  const overlays = createMemo(() => busyOverlays(busy(), workingTint()))
  const imageAttachments = createMemo(
    () => prompt.current().filter((part) => part.type === "image") as ImageAttachmentPart[],
  )

  const [store, setStore] = createStore<{
    popover: "at" | "slash" | null
    historyIndex: number
    savedPrompt: Prompt | null
    dragging: boolean
    mode: "normal" | "shell"
    applyingHistory: boolean
    dictating: boolean
  }>({
    popover: null,
    historyIndex: -1,
    savedPrompt: null,
    dragging: false,
    mode: "normal",
    applyingHistory: false,
    dictating: false,
  })

  const MAX_HISTORY = 100
  const [history, setHistory] = persisted(
    Persist.global("prompt-history", ["prompt-history.v1"]),
    createStore<{
      entries: Prompt[]
    }>({
      entries: [],
    }),
  )
  const [shellHistory, setShellHistory] = persisted(
    Persist.global("prompt-history-shell", ["prompt-history-shell.v1"]),
    createStore<{
      entries: Prompt[]
    }>({
      entries: [],
    }),
  )

  const clonePromptParts = (prompt: Prompt): Prompt =>
    prompt.map((part) => {
      if (part.type === "text") return { ...part }
      if (part.type === "image") return { ...part }
      if (part.type === "agent") return { ...part }
      return {
        ...part,
        selection: part.selection ? { ...part.selection } : undefined,
      }
    })

  const promptLength = (prompt: Prompt) =>
    prompt.reduce((len, part) => len + ("content" in part ? part.content.length : 0), 0)

  const applyHistoryPrompt = (p: Prompt, position: "start" | "end") => {
    const length = position === "start" ? 0 : promptLength(p)
    setStore("applyingHistory", true)
    prompt.set(p, length)
    requestAnimationFrame(() => {
      editorRef.focus()
      setCursorPosition(editorRef, length)
      setStore("applyingHistory", false)
      queueScroll()
    })
  }

  const getCaretState = () => {
    const selection = window.getSelection()
    const textLength = promptLength(prompt.current())
    if (!selection || selection.rangeCount === 0) {
      return { collapsed: false, cursorPosition: 0, textLength }
    }
    const anchorNode = selection.anchorNode
    if (!anchorNode || !editorRef.contains(anchorNode)) {
      return { collapsed: false, cursorPosition: 0, textLength }
    }
    return {
      collapsed: selection.isCollapsed,
      cursorPosition: getCursorPosition(editorRef),
      textLength,
    }
  }

  const isFocused = createFocusSignal(() => editorRef)

  const [composing, setComposing] = createSignal(false)
  const isImeComposing = (event: KeyboardEvent) => event.isComposing || composing() || event.keyCode === 229

  // Whole-dock collapse: one toggle hides the entire usage + action-bar strip
  // (its contents render unchanged when shown). Reclaims vertical space on a
  // crowded viewport without per-component logic.
  const [dockHidden, setDockHidden] = createSignal(false)

  const coarse = createCoarsePointer()
  onMount(() => {
    let armedByTap = false
    const arm = (e: PointerEvent) => {
      armedByTap = e.target instanceof Node && editorRef.contains(e.target)
    }
    const denyUntappedFocus = () => {
      if (!coarse()) return
      if (armedByTap) {
        armedByTap = false
        return
      }
      editorRef.blur()
    }
    document.addEventListener("pointerdown", arm, true)
    editorRef.addEventListener("focusin", denyUntappedFocus)
    onCleanup(() => {
      document.removeEventListener("pointerdown", arm, true)
      editorRef.removeEventListener("focusin", denyUntappedFocus)
    })
  })
  onMount(() => {
    const caretToEndWhenTappedBelow = (e: MouseEvent) => {
      const contents = document.createRange()
      contents.selectNodeContents(editorRef)
      if (e.clientY <= contents.getBoundingClientRect().bottom) return
      caretToEnd()
    }
    editorRef.addEventListener("click", caretToEndWhenTappedBelow)
    onCleanup(() => editorRef.removeEventListener("click", caretToEndWhenTappedBelow))
  })
  // Mobile only: the dock's model/cwd/branch line collapses behind a chevron in
  // the button row so the footer stays compact; expanding it shows the line
  // above the buttons. Desktop always shows the line and has no chevron.
  const [dockInfoOpen, setDockInfoOpen] = createSignal(false)
  const caretToEnd = () => setCursorPosition(editorRef, promptLength(prompt.current()))

  const addImageAttachment = async (file: File) => {
    if (!ACCEPTED_FILE_TYPES.includes(file.type)) return

    if (settings.attachments.compress() && ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      file = await compress(file).catch(() => file)
    }

    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      const attachment: ImageAttachmentPart = {
        type: "image",
        id: crypto.randomUUID(),
        filename: file.name,
        mime: file.type,
        dataUrl,
      }
      const cursorPosition = prompt.cursor() ?? getCursorPosition(editorRef)
      prompt.set([...prompt.current(), attachment], cursorPosition)
    }
    reader.readAsDataURL(file)
  }

  const removeImageAttachment = (id: string) => {
    const current = prompt.current()
    const next = current.filter((part) => part.type !== "image" || part.id !== id)
    prompt.set(next, prompt.cursor())
  }

  const handlePaste = async (event: ClipboardEvent) => {
    if (!isFocused()) return
    const clipboardData = event.clipboardData
    if (!clipboardData) return

    event.preventDefault()
    event.stopPropagation()

    const items = Array.from(clipboardData.items)
    const fileItems = items.filter((item) => item.kind === "file")
    const imageItems = fileItems.filter((item) => ACCEPTED_FILE_TYPES.includes(item.type))

    if (imageItems.length > 0) {
      for (const item of imageItems) {
        const file = item.getAsFile()
        if (file) await addImageAttachment(file)
      }
      return
    }

    if (fileItems.length > 0) {
      showToast({
        title: language.t("prompt.toast.pasteUnsupported.title"),
        description: language.t("prompt.toast.pasteUnsupported.description"),
      })
      return
    }

    const plainText = clipboardData.getData("text/plain") ?? ""
    if (!plainText) return
    addPart({ type: "text", content: plainText, start: 0, end: 0 })
  }

  const handleGlobalDragOver = (event: DragEvent) => {
    if (dialog.active) return

    event.preventDefault()
    const hasFiles = event.dataTransfer?.types.includes("Files")
    if (hasFiles) {
      setStore("dragging", true)
    }
  }

  const handleGlobalDragLeave = (event: DragEvent) => {
    if (dialog.active) return

    // relatedTarget is null when leaving the document window
    if (!event.relatedTarget) {
      setStore("dragging", false)
    }
  }

  const handleGlobalDrop = async (event: DragEvent) => {
    if (dialog.active) return

    event.preventDefault()
    setStore("dragging", false)

    const dropped = event.dataTransfer?.files
    if (!dropped) return

    for (const file of Array.from(dropped)) {
      if (ACCEPTED_FILE_TYPES.includes(file.type)) {
        await addImageAttachment(file)
      }
    }
  }

  onMount(() => {
    document.addEventListener("dragover", handleGlobalDragOver)
    document.addEventListener("dragleave", handleGlobalDragLeave)
    document.addEventListener("drop", handleGlobalDrop)
  })
  onCleanup(() => {
    document.removeEventListener("dragover", handleGlobalDragOver)
    document.removeEventListener("dragleave", handleGlobalDragLeave)
    document.removeEventListener("drop", handleGlobalDrop)
  })

  createEffect(() => {
    if (!isFocused()) setStore("popover", null)
  })

  // Safety: reset composing state on focus change to prevent stuck state
  // This handles edge cases where compositionend event may not fire
  createEffect(() => {
    if (!isFocused()) setComposing(false)
  })

  type AtOption =
    | { type: "agent"; name: string; display: string }
    | { type: "file"; path: string; display: string; recent?: boolean }

  const agentList = createMemo(() =>
    sync.data.agent
      .filter((agent) => !agent.hidden && agent.mode !== "primary")
      .map((agent): AtOption => ({ type: "agent", name: agent.name, display: agent.name })),
  )

  const handleAtSelect = (option: AtOption | undefined) => {
    if (!option) return
    if (option.type === "agent") {
      addPart({ type: "agent", name: option.name, content: "@" + option.name, start: 0, end: 0 })
    } else {
      addPart({ type: "file", path: option.path, content: "@" + option.path, start: 0, end: 0 })
    }
  }

  const atKey = (x: AtOption | undefined) => {
    if (!x) return ""
    return x.type === "agent" ? `agent:${x.name}` : `file:${x.path}`
  }

  const {
    flat: atFlat,
    active: atActive,
    hovered: atHovered,
    hover: atHover,
    unhover: atUnhover,
    onInput: atOnInput,
    onKeyDown: atOnKeyDown,
  } = useFilteredList<AtOption>({
    items: async (query) => {
      const agents = agentList()
      const open = recent()
      const seen = new Set(open)
      const pinned: AtOption[] = open.map((path) => ({ type: "file", path, display: path, recent: true }))
      const paths = await files.searchFilesAndDirectories(query)
      const fileOptions: AtOption[] = paths
        .filter((path) => !seen.has(path))
        .map((path) => ({ type: "file", path, display: path }))
      return [...agents, ...pinned, ...fileOptions]
    },
    key: atKey,
    filterKeys: ["display"],
    groupBy: (item) => {
      if (item.type === "agent") return "agent"
      if (item.recent) return "recent"
      return "file"
    },
    sortGroupsBy: (a, b) => {
      const rank = (category: string) => {
        if (category === "agent") return 0
        if (category === "recent") return 1
        return 2
      }
      return rank(a.category) - rank(b.category)
    },
    onSelect: handleAtSelect,
  })

  const slashCommands = createMemo<SlashCommand[]>(() => {
    const builtin = command.options
      .filter((opt) => !opt.disabled && !opt.id.startsWith("suggested.") && opt.slash)
      .map((opt) => ({
        id: opt.id,
        trigger: opt.slash!,
        title: opt.title,
        description: opt.description,
        keybind: opt.keybind,
        type: "builtin" as const,
      }))

    const custom = sync.data.command.map((cmd) => ({
      id: `custom.${cmd.name}`,
      trigger: cmd.name,
      title: cmd.name,
      description: cmd.description,
      type: "custom" as const,
      source: cmd.source,
    }))

    return [...custom, ...builtin]
  })

  const handleSlashSelect = (cmd: SlashCommand | undefined) => {
    if (!cmd) return
    setStore("popover", null)

    if (cmd.type === "custom") {
      const text = `/${cmd.trigger} `
      editorRef.innerHTML = ""
      editorRef.textContent = text
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      requestAnimationFrame(() => {
        editorRef.focus()
        const range = document.createRange()
        const sel = window.getSelection()
        range.selectNodeContents(editorRef)
        range.collapse(false)
        sel?.removeAllRanges()
        sel?.addRange(range)
      })
      return
    }

    editorRef.innerHTML = ""
    prompt.set([{ type: "text", content: "", start: 0, end: 0 }], 0)
    command.trigger(cmd.id, "slash")
  }

  const {
    flat: slashFlat,
    active: slashActive,
    hovered: slashHovered,
    hover: slashHover,
    unhover: slashUnhover,
    onInput: slashOnInput,
    onKeyDown: slashOnKeyDown,
    refetch: slashRefetch,
  } = useFilteredList<SlashCommand>({
    items: slashCommands,
    key: (x) => x?.id,
    filterKeys: ["trigger", "title", "description"],
    // The typed text is a command name, so the trigger decides the ranking;
    // title and description only surface commands the name alone would miss.
    filterWeights: [1, 0.6, 0.5],
    onSelect: handleSlashSelect,
  })

  const createPill = (part: FileAttachmentPart | AgentPart) => {
    const pill = document.createElement("span")
    pill.textContent = part.content
    pill.setAttribute("data-type", part.type)
    if (part.type === "file") pill.setAttribute("data-path", part.path)
    if (part.type === "agent") pill.setAttribute("data-name", part.name)
    pill.setAttribute("contenteditable", "false")
    pill.style.userSelect = "text"
    pill.style.cursor = "default"
    return pill
  }

  const isNormalizedEditor = () =>
    Array.from(editorRef.childNodes).every((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? ""
        if (!text.includes("\u200B")) return true
        if (text !== "\u200B") return false

        const prev = node.previousSibling
        const next = node.nextSibling
        const prevIsBr = prev?.nodeType === Node.ELEMENT_NODE && (prev as HTMLElement).tagName === "BR"
        const nextIsBr = next?.nodeType === Node.ELEMENT_NODE && (next as HTMLElement).tagName === "BR"
        if (!prevIsBr && !nextIsBr) return false
        if (nextIsBr && !prevIsBr && prev) return false
        return true
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return false
      const el = node as HTMLElement
      if (el.dataset.type === "file") return true
      if (el.dataset.type === "agent") return true
      return el.tagName === "BR"
    })

  const renderEditor = (parts: Prompt) => {
    editorRef.innerHTML = ""
    for (const part of parts) {
      if (part.type === "text") {
        editorRef.appendChild(createTextFragment(part.content))
        continue
      }
      if (part.type === "file" || part.type === "agent") {
        editorRef.appendChild(createPill(part))
      }
    }
  }

  createEffect(
    on(
      () => sync.data.command,
      () => slashRefetch(),
      { defer: true },
    ),
  )

  // Opening or closing a popover leaves the pointer over whatever the other one
  // renders in its place, so a key remembered across that swap marks a row the
  // cursor is not on. Refiltering within one popover is cleared by the hook.
  createEffect(
    on(
      () => store.popover,
      () => {
        slashUnhover()
        atUnhover()
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    const activeId = slashActive()
    if (!activeId || !slashPopoverRef) return

    requestAnimationFrame(() => {
      const element = slashPopoverRef.querySelector(`[data-slash-id="${activeId}"]`)
      element?.scrollIntoView({ block: "nearest", behavior: "smooth" })
    })
  })

  const selectPopoverActive = () => {
    if (store.popover === "at") {
      const items = atFlat()
      if (items.length === 0) return
      const active = atActive()
      const item = items.find((entry) => atKey(entry) === active) ?? items[0]
      handleAtSelect(item)
      return
    }

    if (store.popover === "slash") {
      const items = slashFlat()
      if (items.length === 0) return
      const active = slashActive()
      const item = items.find((entry) => entry.id === active) ?? items[0]
      handleSlashSelect(item)
    }
  }

  createEffect(
    on(
      () => prompt.current(),
      (currentParts) => {
        const inputParts = currentParts.filter((part) => part.type !== "image") as Prompt

        if (mirror.input) {
          mirror.input = false
          if (isNormalizedEditor()) return

          const selection = window.getSelection()
          let cursorPosition: number | null = null
          if (selection && selection.rangeCount > 0 && editorRef.contains(selection.anchorNode)) {
            cursorPosition = getCursorPosition(editorRef)
          }

          renderEditor(inputParts)

          if (cursorPosition !== null) {
            setCursorPosition(editorRef, cursorPosition)
          }
          return
        }

        const domParts = parseFromDOM()
        if (isNormalizedEditor() && isPromptEqual(inputParts, domParts)) return

        const selection = window.getSelection()
        let cursorPosition: number | null = null
        if (selection && selection.rangeCount > 0 && editorRef.contains(selection.anchorNode)) {
          cursorPosition = getCursorPosition(editorRef)
        }

        renderEditor(inputParts)

        // Restore the pre-render caret when it was in the editor. On a session
        // switch there's no in-editor selection to restore, so renderEditor would
        // otherwise leave the caret at the DOM start (before the restored draft).
        // Default to the end so the user resumes typing after existing text. This
        // runs in the same pass as renderEditor, so no later effect can wipe it.
        setCursorPosition(editorRef, cursorPosition ?? promptLength(inputParts))
      },
    ),
  )

  const parseFromDOM = (): Prompt => {
    const parts: Prompt = []
    let position = 0
    let buffer = ""

    const flushText = () => {
      const content = buffer.replace(/\r\n?/g, "\n").replace(/\u200B/g, "")
      buffer = ""
      if (!content) return
      parts.push({ type: "text", content, start: position, end: position + content.length })
      position += content.length
    }

    const pushFile = (file: HTMLElement) => {
      const content = file.textContent ?? ""
      parts.push({
        type: "file",
        path: file.dataset.path!,
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
    }

    const pushAgent = (agent: HTMLElement) => {
      const content = agent.textContent ?? ""
      parts.push({
        type: "agent",
        name: agent.dataset.name!,
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
    }

    const visit = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        buffer += node.textContent ?? ""
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return

      const el = node as HTMLElement
      if (el.dataset.type === "file") {
        flushText()
        pushFile(el)
        return
      }
      if (el.dataset.type === "agent") {
        flushText()
        pushAgent(el)
        return
      }
      if (el.tagName === "BR") {
        buffer += "\n"
        return
      }

      for (const child of Array.from(el.childNodes)) {
        visit(child)
      }
    }

    const children = Array.from(editorRef.childNodes)
    children.forEach((child, index) => {
      const isBlock = child.nodeType === Node.ELEMENT_NODE && ["DIV", "P"].includes((child as HTMLElement).tagName)
      visit(child)
      if (isBlock && index < children.length - 1) {
        buffer += "\n"
      }
    })

    flushText()

    if (parts.length === 0) parts.push(...DEFAULT_PROMPT)
    return parts
  }

  const handleInput = () => {
    const rawParts = parseFromDOM()
    const images = imageAttachments()
    const cursorPosition = getCursorPosition(editorRef)
    const rawText = rawParts.map((p) => ("content" in p ? p.content : "")).join("")
    const trimmed = rawText.replace(/\u200B/g, "").trim()
    const hasNonText = rawParts.some((part) => part.type !== "text")
    const shouldReset = trimmed.length === 0 && !hasNonText && images.length === 0

    if (shouldReset) {
      setStore("popover", null)
      if (store.historyIndex >= 0 && !store.applyingHistory) {
        setStore("historyIndex", -1)
        setStore("savedPrompt", null)
      }
      if (prompt.dirty()) {
        mirror.input = true
        prompt.set(DEFAULT_PROMPT, 0)
      }
      queueScroll()
      return
    }

    const shellMode = store.mode === "shell"

    if (!shellMode) {
      const atMatch = rawText.substring(0, cursorPosition).match(/@(\S*)$/)
      const slashMatch = rawText.match(/^\/(\S*)$/)

      if (atMatch) {
        atOnInput(atMatch[1])
        setStore("popover", "at")
      } else if (slashMatch) {
        slashOnInput(slashMatch[1])
        setStore("popover", "slash")
      } else {
        setStore("popover", null)
      }
    } else {
      setStore("popover", null)
    }

    if (store.historyIndex >= 0 && !store.applyingHistory) {
      setStore("historyIndex", -1)
      setStore("savedPrompt", null)
    }

    mirror.input = true
    prompt.set([...rawParts, ...images], cursorPosition)
    queueScroll()
  }

  const setRangeEdge = (range: Range, edge: "start" | "end", offset: number) => {
    let remaining = offset
    const nodes = Array.from(editorRef.childNodes)

    for (const node of nodes) {
      const length = getNodeLength(node)
      const isText = node.nodeType === Node.TEXT_NODE
      const isPill =
        node.nodeType === Node.ELEMENT_NODE &&
        ((node as HTMLElement).dataset.type === "file" || (node as HTMLElement).dataset.type === "agent")
      const isBreak = node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "BR"

      if (isText && remaining <= length) {
        if (edge === "start") range.setStart(node, remaining)
        if (edge === "end") range.setEnd(node, remaining)
        return
      }

      if ((isPill || isBreak) && remaining <= length) {
        if (edge === "start" && remaining === 0) range.setStartBefore(node)
        if (edge === "start" && remaining > 0) range.setStartAfter(node)
        if (edge === "end" && remaining === 0) range.setEndBefore(node)
        if (edge === "end" && remaining > 0) range.setEndAfter(node)
        return
      }

      remaining -= length
    }
  }

  const addPart = (part: ContentPart) => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return

    const cursorPosition = getCursorPosition(editorRef)
    const currentPrompt = prompt.current()
    const rawText = currentPrompt.map((p) => ("content" in p ? p.content : "")).join("")
    const textBeforeCursor = rawText.substring(0, cursorPosition)
    const atMatch = textBeforeCursor.match(/@(\S*)$/)

    if (part.type === "file" || part.type === "agent") {
      const pill = createPill(part)
      const gap = document.createTextNode(" ")
      const range = selection.getRangeAt(0)

      if (atMatch) {
        const start = atMatch.index ?? cursorPosition - atMatch[0].length
        setRangeEdge(range, "start", start)
        setRangeEdge(range, "end", cursorPosition)
      }

      range.deleteContents()
      range.insertNode(gap)
      range.insertNode(pill)
      range.setStartAfter(gap)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    } else if (part.type === "text") {
      const range = selection.getRangeAt(0)
      const fragment = createTextFragment(part.content)
      const last = fragment.lastChild
      range.deleteContents()
      range.insertNode(fragment)
      if (last) {
        if (last.nodeType === Node.TEXT_NODE) {
          const text = last.textContent ?? ""
          if (text === "\u200B") {
            range.setStart(last, 0)
          }
          if (text !== "\u200B") {
            range.setStart(last, text.length)
          }
        }
        if (last.nodeType !== Node.TEXT_NODE) {
          range.setStartAfter(last)
        }
      }
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    handleInput()
    setStore("popover", null)
  }

  const insertSkill = (name: string) => {
    // The dialog stole focus; restore the caret to the prompt before addPart,
    // which inserts at the current selection.
    editorRef.focus()
    requestAnimationFrame(() => {
      const cursor = prompt.cursor() ?? promptLength(prompt.current())
      setCursorPosition(editorRef, cursor)
      addPart({ type: "text", content: `[USE-SKILL:${name}] `, start: 0, end: 0 })
    })
  }

  // The dictation overlay anchors to the composer, not the dock: the dock also
  // contains the question panel, so its height swings with unrelated UI and
  // dragged the overlay off screen.
  const trackComposer = (el: HTMLElement) => {
    const publish = () => {
      const box = el.getBoundingClientRect()
      // An unrendered composer measures at the origin, so the subtraction below
      // would publish the whole viewport height and put the overlay above the
      // top of the screen. Reader hides the composer while dictation stays
      // reachable from the pill, which is when that happens.
      if (!box.height) {
        document.documentElement.style.removeProperty("--composer-top")
        return
      }
      const gap = Math.max(0, Math.round(window.innerHeight - box.top))
      document.documentElement.style.setProperty("--composer-top", `${gap}px`)
    }
    publish()
    const observer = new ResizeObserver(publish)
    observer.observe(el)
    window.addEventListener("resize", publish)
    onCleanup(() => {
      observer.disconnect()
      window.removeEventListener("resize", publish)
      document.documentElement.style.removeProperty("--composer-top")
    })
  }

  const insertDictation = (text: string) => {
    // Write straight to prompt state. The old path focused the editor and
    // deferred addPart to a rAF, because addPart reads window.getSelection()
    // and needs focus first. On touch that focus raises the soft keyboard, so
    // the rAF landed behind the viewport resize and the text visibly lagged the
    // tap. State needs no selection, so it lands immediately, and it outlives
    // this component so an unmount cannot lose the transcript.
    const next = [...clonePrompt(prompt.current()), { type: "text" as const, content: text + " ", start: 0, end: 0 }]
    const end = promptLength(next)
    prompt.set(next, end)
    if (editorRef?.isConnected) requestAnimationFrame(() => setCursorPosition(editorRef, end))
  }
  const dictation = createDictation({
    url: () => sdk.url,
    onError: (message) => {
      setStore("dictating", false)
      showToast({
        title: language.t("prompt.toast.dictationFailed.title"),
        description: message,
      })
    },
  })

  const toggleDictation = () => {
    if (store.dictating) {
      // Pressing the mic to end a dictation means "I'm done speaking", so the
      // transcript is inserted rather than stashed behind a toast.
      dictation.settle().then((text) => {
        if (text.trim()) insertDictation(text.trim())
      })
      setStore("dictating", false)
      return
    }
    setStore("dictating", true)
    // Speaking is an alternative to typing, so taking the caret would raise the
    // soft keyboard over the overlay the user is about to watch.
    if (!coarse()) editorRef.focus()
    dictation.start()
  }

  // The prompt dock is the fallback dictation target: the shortcut lands here
  // whenever no composer is focused. The mic tints to the agent color to show
  // which composer dictation lands on, on every device, however it was reached
  // (keyboard shortcut, click, or tap). The cue means "this is the active mic",
  // not "here's your shortcut", so it is NOT gated on a coarse pointer.
  registerDictationTarget({ id: "prompt", toggle: toggleDictation }, isFocused, "fallback")
  const dictationTargeted = () => dictationTarget()?.id === "prompt"

  command.register(() => [
    {
      id: "prompt.dictate",
      title: language.t("command.prompt.dictate"),
      description: language.t("command.prompt.dictate.description"),
      category: language.t("command.category.session"),
      keybind: "alt+.",
      // The key that opens the HUD is also the key that closes it, so it is the
      // one binding that has to survive the HUD owning the keyboard.
      overlay: true,
      disabled: !dictation.supported(),
      onSelect: () => dictationTarget()?.toggle(),
    },
    {
      id: "prompt.skill",
      title: language.t("command.prompt.skill"),
      description: language.t("command.prompt.skill.description"),
      category: language.t("command.category.session"),
      keybind: "alt+s",
      onSelect: () => dialog.show(() => <DialogSkill onSelect={insertSkill} />),
    },
    {
      id: "prompt.focus",
      title: language.t("command.prompt.focus"),
      description: language.t("command.prompt.focus.description"),
      category: language.t("command.category.session"),
      keybind: "alt+/",
      onSelect: () => {
        // preventScroll: auto-focus on session load must not scroll the
        // contenteditable (bottom of the dock) into view and yank the message
        // list off its restored position.
        editorRef.focus({ preventScroll: true })
        requestAnimationFrame(() => setCursorPosition(editorRef, prompt.cursor() ?? promptLength(prompt.current())))
      },
    },
    {
      // Clearing is only ever asked for in order to type something else, so the
      // caret comes along and reader is asked for the composer it hides. While
      // the composer holds focus its own handler takes the key instead, where a
      // live selection means the press was aimed at copying.
      id: "prompt.clear",
      title: language.t("command.prompt.clear"),
      description: language.t("command.prompt.clear.description"),
      category: language.t("command.category.session"),
      keybind: "ctrl+c",
      disabled: !prompt.dirty() || isFocused(),
      onSelect: () => {
        clearPrompt()
        layout.reader.composer.summon()
        editorRef.focus({ preventScroll: true })
      },
    },
    {
      // Like prompt.focus but always lands the caret at the end of the draft,
      // ignoring the persisted mid-edit position. Used on session switch/open so
      // the user resumes typing after existing text, not before it.
      id: "prompt.focus.end",
      title: language.t("command.prompt.focus"),
      description: language.t("command.prompt.focus.description"),
      category: language.t("command.category.session"),
      onSelect: () => {
        editorRef.focus({ preventScroll: true })
        requestAnimationFrame(() => setCursorPosition(editorRef, promptLength(prompt.current())))
      },
    },
  ])

  // In-place stop (Esc / the dock stop button): abort only the in-flight turn,
  // leaving the ping daemon armed and the session warm. abortTurn (not abort)
  // is the turn-only route — this is NOT the stop-and-disarm-and-leave action
  // the header/overview use.
  const abort = () => {
    const sessionID = params.id
    if (!sessionID) return
    abortTurn(sdk.client, sessionID)
  }

  const addToHistory = (prompt: Prompt, mode: "normal" | "shell") => {
    const text = prompt
      .map((p) => ("content" in p ? p.content : ""))
      .join("")
      .trim()
    const hasImages = prompt.some((part) => part.type === "image")
    if (!text && !hasImages) return

    const entry = clonePromptParts(prompt)
    const currentHistory = mode === "shell" ? shellHistory : history
    const setCurrentHistory = mode === "shell" ? setShellHistory : setHistory
    const lastEntry = currentHistory.entries[0]
    if (lastEntry && isPromptEqual(lastEntry, entry)) return

    setCurrentHistory("entries", (entries) => [entry, ...entries].slice(0, MAX_HISTORY))
  }

  // Empty the composer. Attachments and pinned context survive: this is the
  // text field's own clear, and each attachment carries its own remove control.
  const clearPrompt = () => {
    prompt.reset()
    setStore("mode", "normal")
    setStore("popover", null)
  }

  // Leaving shell mode stashes the command rather than carrying it into normal
  // mode, where the same Enter would send it to the model as a prompt.
  const exitShell = () => {
    setStore("mode", "normal")
    if (!prompt.dirty()) return
    stash.push(prompt.current(), prompt.context.items())
    prompt.reset()
    prompt.context.clear()
    // Clearing a typed command reads as losing it unless the stash is named.
    showToast({
      title: language.t("prompt.mode.shell.stashed.title"),
      description: language.t("prompt.mode.shell.stashed.description"),
    })
  }

  const navigateHistory = (direction: "up" | "down") => {
    const entries = store.mode === "shell" ? shellHistory.entries : history.entries
    const current = store.historyIndex

    if (direction === "up") {
      if (entries.length === 0) return false
      if (current === -1) {
        setStore("savedPrompt", clonePromptParts(prompt.current()))
        setStore("historyIndex", 0)
        applyHistoryPrompt(entries[0], "start")
        return true
      }
      if (current < entries.length - 1) {
        const next = current + 1
        setStore("historyIndex", next)
        applyHistoryPrompt(entries[next], "start")
        return true
      }
      return false
    }

    if (current > 0) {
      const next = current - 1
      setStore("historyIndex", next)
      applyHistoryPrompt(entries[next], "end")
      return true
    }
    if (current === 0) {
      setStore("historyIndex", -1)
      const saved = store.savedPrompt
      if (saved) {
        applyHistoryPrompt(saved, "end")
        setStore("savedPrompt", null)
        return true
      }
      applyHistoryPrompt(DEFAULT_PROMPT, "end")
      return true
    }

    return false
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Backspace") {
      const selection = window.getSelection()
      if (selection && selection.isCollapsed) {
        const node = selection.anchorNode
        const offset = selection.anchorOffset
        if (node && node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent ?? ""
          if (/^\u200B+$/.test(text) && offset > 0) {
            const range = document.createRange()
            range.setStart(node, 0)
            range.collapse(true)
            selection.removeAllRanges()
            selection.addRange(range)
          }
        }
      }
    }

    if (event.key === "!" && store.mode === "normal") {
      const cursorPosition = getCursorPosition(editorRef)
      if (cursorPosition === 0) {
        event.preventDefault()
        setStore("mode", "shell")
        setStore("popover", null)
        return
      }
    }
    if (store.mode === "shell") {
      const { collapsed, cursorPosition, textLength } = getCaretState()
      if (event.key === "Escape") {
        exitShell()
        event.preventDefault()
        return
      }
      if (event.key === "Backspace" && collapsed && cursorPosition === 0 && textLength === 0) {
        exitShell()
        event.preventDefault()
        return
      }
    }

    // Handle Shift+Enter BEFORE IME check - Shift+Enter is never used for IME input
    // and should always insert a newline regardless of composition state
    if (event.key === "Enter" && event.shiftKey) {
      addPart({ type: "text", content: "\n", start: 0, end: 0 })
      event.preventDefault()
      return
    }

    if (event.key === "Enter" && isImeComposing(event)) {
      return
    }

    const ctrl = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey

    if (store.popover) {
      if (event.key === "Tab") {
        selectPopoverActive()
        event.preventDefault()
        return
      }
      const nav = event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Enter"
      const ctrlNav = ctrl && (event.key === "n" || event.key === "p")
      if (nav || ctrlNav) {
        if (store.popover === "at") {
          atOnKeyDown(event)
          event.preventDefault()
          return
        }
        if (store.popover === "slash") {
          slashOnKeyDown(event)
        }
        event.preventDefault()
        return
      }
    }

    if (ctrl && event.code === "KeyG") {
      if (store.popover) {
        setStore("popover", null)
        event.preventDefault()
        return
      }
      if (working()) {
        abort()
        event.preventDefault()
      }
      return
    }

    // Ctrl+C clears the input, matching the TUI. A non-collapsed selection means
    // the user is copying, so let the browser handle it and clear nothing.
    if (ctrl && event.code === "KeyC") {
      if (overlayActive()) return
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed) return
      clearPrompt()
      event.preventDefault()
      return
    }

    // Prompt history is explicit: ctrl+shift+up / ctrl+shift+down. Plain up/down
    // stay native caret movement, so they always move within the text (including
    // wrapped rows) and never surprise-jump to a previous prompt. Ctrl+Shift is
    // used because every other arrow combo is a reserved macOS text shortcut
    // (option = paragraph, cmd = document), while plain ctrl+arrow is Mission
    // Control; adding shift dodges both.
    if (
      (event.key === "ArrowUp" || event.key === "ArrowDown") &&
      event.ctrlKey &&
      event.shiftKey &&
      !event.altKey &&
      !event.metaKey
    ) {
      if (navigateHistory(event.key === "ArrowUp" ? "up" : "down")) event.preventDefault()
      return
    }

    // Note: Shift+Enter is handled earlier, before IME check
    if (event.key === "Enter" && !event.shiftKey) {
      handleSubmit(event)
    }
    if (event.key === "Escape") {
      if (overlayActive()) return
      if (store.popover) {
        setStore("popover", null)
        return
      }
      // The session page dismisses the summoned composer on this same key, and
      // it bubbles there after this handler. Aborting here too spends one press
      // on two unrelated actions, the destructive one unasked for.
      if (reader()) return
      if (working()) abort()
    }
  }

  // Guards the new-session create window against a double-submit from ANY source
  // (a touch pointerdown+click pair, a genuine rapid double Enter/tap, a future
  // handler): two concurrent handleSubmit calls on a session-less view would each
  // run session.create() and mint two root sessions.
  //
  // The latch spans the whole session-less window, not just the create round
  // trip. navigate() commits params.id on a later tick (solid-router routes it
  // through startTransition), so releasing the moment the POST resolves leaves a
  // gap where the latch is down and info() is still undefined — a submit landing
  // there sees a session-less view again and mints a duplicate. Releasing is
  // therefore driven by the view returning to session-less (below) or by a failed
  // create, never by the create resolving. The route keeps one component instance
  // across /session -> /session/:id, so the latch survives the navigation.
  let creating = false
  createEffect(
    on(
      () => params.id,
      (id) => {
        if (!id) creating = false
      },
    ),
  )

  const handleSubmit = async (event: Event) => {
    event.preventDefault()

    // Mouse-submit while dictating: unmounting the overlay stashes the
    // transcript into the (fresh) draft via its cleanup, so nothing vanishes.
    if (store.dictating) setStore("dictating", false)

    const currentPrompt = prompt.current()
    const text = currentPrompt.map((part) => ("content" in part ? part.content : "")).join("")
    const images = imageAttachments().slice()
    const mode = store.mode

    if (text.trim().length === 0 && images.length === 0 && commentCount() === 0) {
      return
    }

    const currentModel = local.model.current()
    const currentAgent = local.agent.current()
    if (!currentModel || !currentAgent) {
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    const errorMessage = (err: unknown) => {
      if (err && typeof err === "object" && "data" in err) {
        const data = (err as { data?: { message?: string } }).data
        if (data?.message) return data.message
      }
      if (err instanceof Error) return err.message
      return language.t("common.requestFailed")
    }

    // A prompt queues behind a running turn, but shell takes the session's
    // in-flight handle exclusively and the server rejects it outright. Say so
    // here and keep the draft, rather than losing it to a Session is busy error.
    if (mode === "shell" && busy().busySelf) {
      showToast({
        title: language.t("prompt.toast.shellBusy.title"),
        description: language.t("prompt.toast.shellBusy.description"),
      })
      return
    }

    addToHistory(currentPrompt, mode)
    setStore("historyIndex", -1)
    setStore("savedPrompt", null)

    const clearInput = () => {
      prompt.reset()
      setStore("mode", "normal")
      setStore("popover", null)
    }

    const restoreInput = () => {
      prompt.set(currentPrompt, promptLength(currentPrompt))
      setStore("mode", mode)
      setStore("popover", null)
      requestAnimationFrame(() => {
        editorRef.focus()
        setCursorPosition(editorRef, promptLength(currentPrompt))
        queueScroll()
      })
    }

    const projectDirectory = sdk.directory
    const isNewSession = !params.id
    const worktreeSelection = props.newSessionWorktree ?? "main"

    let sessionDirectory = projectDirectory
    let client = sdk.client

    if (isNewSession) {
      // The create round-trip happens before any of the visible submit effects,
      // so on a remote client the press otherwise changes nothing on screen for
      // the whole RTT. Clear now; every failure path below restores the draft.
      clearInput()

      if (worktreeSelection === "create") {
        const createdWorktree = await client.worktree
          .create({ directory: projectDirectory })
          .then((x) => x.data)
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.worktreeCreateFailed.title"),
              description: errorMessage(err),
            })
            return undefined
          })

        if (!createdWorktree?.directory) {
          showToast({
            title: language.t("prompt.toast.worktreeCreateFailed.title"),
            description: language.t("common.requestFailed"),
          })
          restoreInput()
          return
        }
        WorktreeState.pending(createdWorktree.directory)
        sessionDirectory = createdWorktree.directory
      }

      if (worktreeSelection !== "main" && worktreeSelection !== "create") {
        sessionDirectory = worktreeSelection
      }

      if (sessionDirectory !== projectDirectory) {
        client = createOpencodeClient({
          baseUrl: sdk.url,
          fetch: platform.fetch,
          directory: sessionDirectory,
          throwOnError: true,
        })
        globalSync.child(sessionDirectory)
      }

      props.onNewSessionWorktreeReset?.()
    }

    let session = info()
    // A root session minted by this submit exists only to carry the prompt that
    // follows. If that prompt never lands, the record is an orphan: zero
    // messages, nothing to resume, but it still lists and still counts as needing
    // attention. Reap it on the failure paths so a session never outlives the
    // send that justified it. Only ever set for a session created right here —
    // an existing session is the user's and is never reaped on a failed send.
    let created: string | undefined
    const reapCreated = () => {
      if (!created) return
      const id = created
      created = undefined
      void client.session.delete({ sessionID: id, directory: sessionDirectory }).catch(() => {})
    }
    if (!session && isNewSession) {
      // Drop a concurrent submit on a session-less view: the first one owns the
      // create, a second would mint a duplicate root session. The dropped
      // submit already cleared its draft above, so put it back.
      if (creating) {
        restoreInput()
        return
      }
      creating = true
      session = await client.session
        .create()
        .then((x) => x.data ?? undefined)
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.sessionCreateFailed.title"),
            description: errorMessage(err),
          })
          creating = false
          return undefined
        })
      if (session) {
        created = session.id
        // Seed BEFORE navigating: the session page reads the store on mount, so
        // arriving already-hydrated is what removes the two blocking fetches
        // from the first paint. Seeding after would lose the race it exists to win.
        sync.session.seed(session, sessionDirectory)
        // Creating a session is an explicit open — declare keep-warm intent up
        // front (same client + directory used to create it). The organic turn
        // about to run also sets it, but only on completion; arming here closes
        // the gap so a concurrent client can't read it cold in between.
        void client.session.arm({ sessionID: session.id, directory: sessionDirectory })
        navigate(`/${base64Encode(sessionDirectory)}/session/${session.id}`)
      }
    }
    if (!session) {
      if (isNewSession) restoreInput()
      return
    }

    const model = {
      modelID: currentModel.id,
      providerID: currentModel.provider.id,
    }
    // Only an explicit pick rides on the request; otherwise the server resolves
    // the default itself, off config newer than this tab's copy. `model` above
    // is the resolved display value, right for the optimistic message but not
    // something to pin the turn to.
    const requestModel = local.model.picked()
    const agent = currentAgent.name
    const variant = local.model.variant.current()

    // Pre-allocate the id every send path uses, so a send that fails in transit
    // can confirm receipt (read the message back) before restoring the draft,
    // rather than restoring blindly on a drop that landed server-side.
    const messageID = Identifier.ascending("message")
    const wasReceived = async () =>
      !(await confirmAbsent(() =>
        client.session.message({ sessionID: session.id, messageID, directory: sessionDirectory }),
      ))

    if (mode === "shell") {
      clearInput()
      props.onSubmit?.()
      client.session
        .shell({
          sessionID: session.id,
          messageID,
          agent,
          model,
          command: text,
        })
        .catch(async (err) => {
          if (err instanceof Error && (await wasReceived())) return
          showToast({
            title: language.t("prompt.toast.shellSendFailed.title"),
            description: errorMessage(err),
          })
          reapCreated()
          restoreInput()
        })
      return
    }

    if (text.startsWith("/")) {
      const [cmdName, ...args] = text.split(" ")
      const commandName = cmdName.slice(1)
      const customCommand = sync.data.command.find((c) => c.name === commandName)
      if (customCommand) {
        clearInput()
        props.onSubmit?.()
        client.session
          .command({
            sessionID: session.id,
            messageID,
            command: commandName,
            arguments: args.join(" "),
            agent,
            model: `${model.providerID}/${model.modelID}`,
            variant,
            parts: images.map((attachment) => ({
              id: Identifier.ascending("part"),
              type: "file" as const,
              mime: attachment.mime,
              url: attachment.dataUrl,
              filename: attachment.filename,
            })),
          })
          .catch(async (err) => {
            if (err instanceof Error && (await wasReceived())) return
            showToast({
              title: language.t("prompt.toast.commandSendFailed.title"),
              description: errorMessage(err),
            })
            reapCreated()
            restoreInput()
          })
        return
      }
    }

    const toAbsolutePath = (path: string) =>
      path.startsWith("/") ? path : (sessionDirectory + "/" + path).replace("//", "/")

    const fileAttachments = currentPrompt.filter((part) => part.type === "file") as FileAttachmentPart[]
    const agentAttachments = currentPrompt.filter((part) => part.type === "agent") as AgentPart[]

    const fileAttachmentParts = fileAttachments.map((attachment) => {
      const absolute = toAbsolutePath(attachment.path)
      const query = attachment.selection
        ? `?start=${attachment.selection.startLine}&end=${attachment.selection.endLine}`
        : ""
      return {
        id: Identifier.ascending("part"),
        type: "file" as const,
        mime: "text/plain",
        url: `file://${absolute}${query}`,
        filename: getFilename(attachment.path),
        source: {
          type: "file" as const,
          text: {
            value: attachment.content,
            start: attachment.start,
            end: attachment.end,
          },
          path: absolute,
        },
      }
    })

    const agentAttachmentParts = agentAttachments.map((attachment) => ({
      id: Identifier.ascending("part"),
      type: "agent" as const,
      name: attachment.name,
      source: {
        value: attachment.content,
        start: attachment.start,
        end: attachment.end,
      },
    }))

    const usedUrls = new Set(fileAttachmentParts.map((part) => part.url))

    const context = prompt.context.items().slice()

    const commentItems = context.filter((item) => item.type === "file" && !!item.comment?.trim())

    const contextParts: Array<
      | {
          id: string
          type: "text"
          text: string
          synthetic?: boolean
        }
      | {
          id: string
          type: "file"
          mime: string
          url: string
          filename?: string
        }
    > = []

    const commentNote = (
      path: string,
      selection: FileSelection | undefined,
      comment: string,
      snippet: string | undefined,
    ) => {
      if (snippet) return `The user commented on this diff in ${path}:\n${snippet}\nComment: ${comment}`

      const start = selection ? Math.min(selection.startLine, selection.endLine) : undefined
      const end = selection ? Math.max(selection.startLine, selection.endLine) : undefined
      const range =
        start === undefined || end === undefined
          ? "this file"
          : start === end
            ? `line ${start}`
            : `lines ${start} through ${end}`

      return `The user made the following comment regarding ${range} of ${path}: ${comment}`
    }

    const addContextFile = (input: {
      path: string
      selection?: FileSelection
      comment?: string
      snippet?: string
      deletionOnly?: boolean
    }) => {
      const absolute = toAbsolutePath(input.path)
      const query = input.selection ? `?start=${input.selection.startLine}&end=${input.selection.endLine}` : ""
      const url = `file://${absolute}${query}`

      const comment = input.comment?.trim()
      if (!comment && usedUrls.has(url)) return
      usedUrls.add(url)

      if (comment) {
        contextParts.push({
          id: Identifier.ascending("part"),
          type: "text",
          text: commentNote(input.path, input.selection, comment, input.snippet),
          synthetic: true,
        })
      }

      // A deletion-only selection references old-file lines. Slicing the current
      // file at those numbers would attach the wrong content, so skip the attach:
      // the snippet in the note already carries the exact deleted text.
      if (input.deletionOnly) return

      contextParts.push({
        id: Identifier.ascending("part"),
        type: "file",
        mime: "text/plain",
        url,
        filename: getFilename(input.path),
      })
    }

    for (const item of context) {
      if (item.type !== "file") continue
      addContextFile({
        path: item.path,
        selection: item.selection,
        comment: item.comment,
        snippet: item.snippet,
        deletionOnly: item.deletionOnly,
      })
    }

    const imageAttachmentParts = images.map((attachment) => ({
      id: Identifier.ascending("part"),
      type: "file" as const,
      mime: attachment.mime,
      url: attachment.dataUrl,
      filename: attachment.filename,
    }))

    const textPart = {
      id: Identifier.ascending("part"),
      type: "text" as const,
      text,
    }
    const requestParts = [
      textPart,
      ...fileAttachmentParts,
      ...contextParts,
      ...agentAttachmentParts,
      ...imageAttachmentParts,
    ]

    const optimisticParts = requestParts.map((part) => ({
      ...part,
      sessionID: session.id,
      messageID,
    })) as unknown as Part[]

    const optimisticMessage: Message = {
      id: messageID,
      sessionID: session.id,
      role: "user",
      time: { created: Date.now() },
      agent,
      model,
    }

    const addOptimisticMessage = () => {
      if (sessionDirectory === projectDirectory) {
        sync.set(
          produce((draft) => {
            const messages = draft.message[session.id]
            if (!messages) {
              draft.message[session.id] = [optimisticMessage]
            } else {
              const result = Binary.search(messages, messageID, (m) => m.id)
              messages.splice(result.index, 0, optimisticMessage)
            }
            draft.part[messageID] = optimisticParts
              .filter((p) => !!p?.id)
              .slice()
              .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          }),
        )
        return
      }

      globalSync.child(sessionDirectory)[1](
        produce((draft) => {
          const messages = draft.message[session.id]
          if (!messages) {
            draft.message[session.id] = [optimisticMessage]
          } else {
            const result = Binary.search(messages, messageID, (m) => m.id)
            messages.splice(result.index, 0, optimisticMessage)
          }
          draft.part[messageID] = optimisticParts
            .filter((p) => !!p?.id)
            .slice()
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        }),
      )
    }

    const removeOptimisticMessage = () => {
      if (sessionDirectory === projectDirectory) {
        sync.set(
          produce((draft) => {
            const messages = draft.message[session.id]
            if (messages) {
              const result = Binary.search(messages, messageID, (m) => m.id)
              if (result.found) messages.splice(result.index, 1)
            }
            delete draft.part[messageID]
          }),
        )
        return
      }

      globalSync.child(sessionDirectory)[1](
        produce((draft) => {
          const messages = draft.message[session.id]
          if (messages) {
            const result = Binary.search(messages, messageID, (m) => m.id)
            if (result.found) messages.splice(result.index, 1)
          }
          delete draft.part[messageID]
        }),
      )
    }

    for (const item of commentItems) {
      prompt.context.remove(item.key)
    }

    clearInput()
    addOptimisticMessage()

    // Re-arms follow and settles the transcript to the bottom. Runs AFTER the
    // optimistic message mounts: settleToBottom exits only once scrollHeight
    // holds steady, so starting it before the message exists makes it settle
    // against a height that is about to change and burn its full frame budget.
    props.onSubmit?.()

    // Optimistic own-turn busy: flip the operative store instantly so Send
    // becomes Stop on the press instead of waiting for the server to publish
    // session.busy over SSE (or the 5s reconcile tick). Without this the only
    // feedback for a press is the button disabling, which reads as "nothing
    // happened" and invites a second press. The reconcile tick confirms it, and
    // the send-failure path below clears it. busySelf:true — this is our turn.
    if (sessionDirectory === projectDirectory) {
      sync.set("session_busy", session.id, { busy: true, busySelf: true, busyDescendant: false })
    }

    const waitForWorktree = async () => {
      const worktree = WorktreeState.get(sessionDirectory)
      if (!worktree || worktree.status !== "pending") return true

      const controller = new AbortController()

      const cleanup = () => {
        if (sessionDirectory === projectDirectory) {
          sync.set("session_busy", session.id, { busy: false, busySelf: false, busyDescendant: false })
        }
        reapCreated()
        removeOptimisticMessage()
        for (const item of commentItems) {
          prompt.context.add({
            type: "file",
            path: item.path,
            selection: item.selection,
            comment: item.comment,
            commentID: item.commentID,
            commentOrigin: item.commentOrigin,
            preview: item.preview,
          })
        }
        restoreInput()
      }

      pending.set(session.id, { abort: controller, cleanup })

      const abort = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        if (controller.signal.aborted) {
          resolve({ status: "failed", message: "aborted" })
          return
        }
        controller.signal.addEventListener(
          "abort",
          () => {
            resolve({ status: "failed", message: "aborted" })
          },
          { once: true },
        )
      })

      const timeoutMs = 5 * 60 * 1000
      const timer = { id: undefined as number | undefined }
      const timeout = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        timer.id = window.setTimeout(() => {
          resolve({ status: "failed", message: language.t("workspace.error.stillPreparing") })
        }, timeoutMs)
      })

      const result = await Promise.race([WorktreeState.wait(sessionDirectory), abort, timeout]).finally(() => {
        if (timer.id === undefined) return
        clearTimeout(timer.id)
      })
      pending.delete(session.id)
      if (controller.signal.aborted) return false
      if (result.status === "failed") throw new Error(result.message)
      return true
    }

    const send = async () => {
      const ok = await waitForWorktree()
      if (!ok) return
      // prompt_async returns as soon as the turn is accepted; the synchronous
      // prompt route holds the connection open for the whole turn and writes no
      // bytes, so a turn past the server's idle timeout gets its POST reaped.
      // Results stream over SSE regardless, so the response body is unused.
      await client.session.promptAsync({
        sessionID: session.id,
        agent,
        model: requestModel,
        messageID,
        parts: requestParts,
        variant,
      })
    }

    void send().catch(async (err) => {
      pending.delete(session.id)
      // Transport failures reject with an Error subclass — TypeError for a
      // network/connection drop (server restart mid-turn) per the WHATWG fetch
      // spec, DOMException for an abort. HTTP error responses (validation 400,
      // session 404) reject with the server's parsed error body, a plain value,
      // NOT an Error instance (the hey-api client throws the parsed body). The
      // latter means the message was never created and the input should be
      // restored. A transport error is ambiguous: a drop AFTER the server
      // received the prompt leaves a persisted message + real turn error for
      // SSE to heal (restoring would clobber both), but a drop BEFORE receipt
      // created nothing and strands the session busy with the draft lost. The
      // pre-allocated messageID lets us disambiguate: confirm receipt, and only
      // restore when the server confirms the message is absent.
      //
      // The confirmation is a read across the same window that dropped the send,
      // so it must be trusted only when it lands over a healthy connection. A
      // NotFound is believed only if it holds across retries; a single one can be
      // the write settling behind a just-recovered server. A read that itself
      // fails is unknown, not absent, so it never restores.
      if (err instanceof Error && (await wasReceived())) return
      if (sessionDirectory === projectDirectory) {
        // Send failed before a turn began — undo the optimistic busy. No subtask
        // can exist yet, so clearing both facts is correct; the reconcile tick
        // backstops it regardless.
        sync.set("session_busy", session.id, { busy: false, busySelf: false, busyDescendant: false })
      }
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: errorMessage(err),
      })
      reapCreated()
      removeOptimisticMessage()
      for (const item of commentItems) {
        prompt.context.add({
          type: "file",
          path: item.path,
          selection: item.selection,
          comment: item.comment,
          commentID: item.commentID,
          commentOrigin: item.commentOrigin,
          preview: item.preview,
        })
      }
      restoreInput()
    })
  }

  return (
    /* An element cannot match a container query against itself, so the styled
       classes sit one level inside the declaration. */
    <div class="@container/dock size-full">
      <div class="relative size-full _max-h-[320px] flex flex-col gap-1 dock-wide:gap-3 [--dock-font-size:var(--font-size-x-small)] dock-wide:[--dock-font-size:var(--font-size-small)]">
        <Show when={store.popover}>
          <div
            ref={(el) => {
              if (store.popover === "slash") slashPopoverRef = el
            }}
            class="absolute inset-x-0 -top-3 -translate-y-full origin-bottom-left max-h-80 min-h-10
                 overflow-auto no-scrollbar flex flex-col p-2 rounded-md
                 border border-border-base bg-surface-raised-stronger-non-alpha shadow-md"
            onMouseDown={(e) => e.preventDefault()}
          >
            <Switch>
              <Match when={store.popover === "at"}>
                <Show
                  when={atFlat().length > 0}
                  fallback={<div class="text-text-weak px-2 py-1">{language.t("prompt.popover.emptyResults")}</div>}
                >
                  <For each={atFlat().slice(0, 10)}>
                    {(item) => (
                      <button
                        data-popover-item=""
                        data-cursor={atActive() === atKey(item)}
                        data-hovered={atHovered() === atKey(item)}
                        classList={{
                          "w-full flex items-center gap-x-2 rounded-md px-2 py-0.5": true,
                        }}
                        onClick={() => handleAtSelect(item)}
                        onMouseMove={(event) => atHover(event, atKey(item))}
                        onMouseLeave={atUnhover}
                      >
                        <Show
                          when={item.type === "agent"}
                          fallback={
                            <>
                              <FileIcon
                                node={{ path: (item as { type: "file"; path: string }).path, type: "file" }}
                                class="shrink-0 size-4"
                              />
                              <div class="flex items-center text-14-regular min-w-0">
                                <span class="text-text-weak whitespace-nowrap truncate min-w-0">
                                  {(() => {
                                    const path = (item as { type: "file"; path: string }).path
                                    return path.endsWith("/") ? path : getDirectory(path)
                                  })()}
                                </span>
                                <Show when={!(item as { type: "file"; path: string }).path.endsWith("/")}>
                                  <span class="text-text-strong whitespace-nowrap">
                                    {getFilename((item as { type: "file"; path: string }).path)}
                                  </span>
                                </Show>
                              </div>
                            </>
                          }
                        >
                          <Icon name="brain" size="small" class="text-icon-info-active shrink-0" />
                          <span class="text-14-regular text-text-strong whitespace-nowrap">
                            @{(item as { type: "agent"; name: string }).name}
                          </span>
                        </Show>
                      </button>
                    )}
                  </For>
                </Show>
              </Match>
              <Match when={store.popover === "slash"}>
                <Show
                  when={slashFlat().length > 0}
                  fallback={<div class="text-text-weak px-2 py-1">{language.t("prompt.popover.emptyCommands")}</div>}
                >
                  <For each={slashFlat()}>
                    {(cmd) => (
                      <button
                        data-slash-id={cmd.id}
                        data-popover-item=""
                        data-cursor={slashActive() === cmd.id}
                        data-hovered={slashHovered() === cmd.id}
                        classList={{
                          "w-full flex items-center justify-between gap-4 rounded-md px-2 py-1": true,
                        }}
                        onClick={() => handleSlashSelect(cmd)}
                        onMouseMove={(event) => slashHover(event, cmd.id)}
                        onMouseLeave={slashUnhover}
                      >
                        <div class="flex items-center gap-2 min-w-0">
                          <span class="text-14-regular text-text-strong whitespace-nowrap">/{cmd.trigger}</span>
                          <Show when={cmd.description}>
                            <span class="text-14-regular text-text-weak truncate">{cmd.description}</span>
                          </Show>
                        </div>
                        <div class="flex items-center gap-2 shrink-0">
                          <Show when={cmd.type === "custom" && cmd.source !== "command"}>
                            <span class="text-11-regular text-text-subtle px-1.5 py-0.5 bg-surface-base rounded">
                              {cmd.source === "skill"
                                ? language.t("prompt.slash.badge.skill")
                                : cmd.source === "mcp"
                                  ? language.t("prompt.slash.badge.mcp")
                                  : language.t("prompt.slash.badge.custom")}
                            </span>
                          </Show>
                          <Show when={command.keybind(cmd.id)}>
                            <span class="text-12-regular text-text-subtle">{command.keybind(cmd.id)}</span>
                          </Show>
                        </div>
                      </button>
                    )}
                  </For>
                </Show>
              </Match>
            </Switch>
          </div>
        </Show>
        <form
          onSubmit={handleSubmit}
          ref={(el) => trackComposer(el)}
          classList={{
            "group/prompt-input": true,
            "bg-surface-raised-stronger-non-alpha shadow-xs-border relative": true,
            "rounded-[14px] overflow-clip focus-within:shadow-xs-border": true,
            "border-icon-info-active border-dashed": store.dragging,
            [props.class ?? ""]: !!props.class,
          }}
        >
          <Show when={store.dictating}>
            <DictationOverlay
              dictation={dictation}
              accent={workingTint()}
              onAccept={insertDictation}
              onClose={() => setStore("dictating", false)}
            />
          </Show>
          <Show when={prompt.dirty()}>
            <div class="absolute top-0.5 right-0.5 z-20">
              <Tooltip
                placement="top"
                value={
                  <div class="flex items-center gap-2">
                    <span>{language.t("prompt.action.clear")}</span>
                    <span class="text-icon-base text-12-medium text-[10px]!">^C</span>
                  </div>
                }
              >
                <IconButton
                  type="button"
                  icon="close"
                  variant="ghost"
                  aria-label={language.t("prompt.action.clear")}
                  onClick={() => {
                    clearPrompt()
                    editorRef.focus()
                  }}
                />
              </Tooltip>
            </div>
          </Show>
          <Show when={store.dragging}>
            <div class="absolute inset-0 z-10 flex items-center justify-center bg-surface-raised-stronger-non-alpha/90 pointer-events-none">
              <div class="flex flex-col items-center gap-2 text-text-weak">
                <Icon name="photo" class="size-8" />
                <span class="text-14-regular">{language.t("prompt.dropzone.label")}</span>
              </div>
            </div>
          </Show>
          <Show when={prompt.context.items().length > 0}>
            <div class="flex flex-nowrap items-start gap-2 p-2 overflow-x-auto no-scrollbar">
              <For each={prompt.context.items()}>
                {(item) => {
                  const active = () => {
                    const a = comments.active()
                    return !!item.commentID && item.commentID === a?.id && item.path === a?.file
                  }
                  return (
                    <Tooltip
                      value={
                        <span class="flex max-w-[300px]">
                          <span class="text-text-invert-base truncate-start [unicode-bidi:plaintext] min-w-0">
                            {getDirectory(item.path)}
                          </span>
                          <span class="shrink-0">{getFilename(item.path)}</span>
                        </span>
                      }
                      placement="top"
                      openDelay={2000}
                    >
                      <div
                        classList={{
                          "group shrink-0 flex flex-col rounded-[6px] pl-2 pr-1 py-1 max-w-[200px] h-12 transition-all transition-transform shadow-xs-border hover:shadow-xs-border-hover": true,
                          "cursor-pointer hover:bg-surface-interactive-weak": !!item.commentID && !active(),
                          "cursor-pointer bg-surface-interactive-hover hover:bg-surface-interactive-hover shadow-xs-border-hover":
                            active(),
                          "bg-background-stronger": !active(),
                        }}
                        onClick={() => {
                          openComment(item)
                        }}
                      >
                        <div class="flex items-center gap-1.5">
                          <FileIcon node={{ path: item.path, type: "file" }} class="shrink-0 size-3.5" />
                          <div class="flex items-center text-11-regular min-w-0 font-medium">
                            <span class="text-text-strong whitespace-nowrap">
                              {getFilenameTruncated(item.path, 14)}
                            </span>
                            <Show when={item.selection}>
                              {(sel) => (
                                <span class="text-text-weak whitespace-nowrap shrink-0">
                                  {sel().side === "before" ? "\u2212" : ""}
                                  {sel().startLine === sel().endLine
                                    ? `:${sel().startLine}`
                                    : `:${sel().startLine}-${sel().endLine}`}
                                </span>
                              )}
                            </Show>
                          </div>
                          <IconButton
                            type="button"
                            icon="close-small"
                            variant="ghost"
                            class="ml-auto size-3.5 opacity-0 group-hover:opacity-100 transition-all"
                            onClick={(e) => {
                              e.stopPropagation()
                              if (item.commentID) comments.remove(item.path, item.commentID)
                              prompt.context.remove(item.key)
                            }}
                            aria-label={language.t("prompt.context.removeFile")}
                          />
                        </div>
                        <Show when={item.comment}>
                          {(comment) => (
                            <div class="text-12-regular text-text-strong ml-5 pr-1 truncate">{comment()}</div>
                          )}
                        </Show>
                      </div>
                    </Tooltip>
                  )
                }}
              </For>
            </div>
          </Show>
          <Show when={imageAttachments().length > 0}>
            <div class="flex flex-wrap gap-2 px-3 pt-3">
              <For each={imageAttachments()}>
                {(attachment) => (
                  <div class="relative group">
                    <Show
                      when={attachment.mime.startsWith("image/")}
                      fallback={
                        <div class="size-16 rounded-md bg-surface-base flex items-center justify-center border border-border-base">
                          <Icon name="folder" class="size-6 text-text-weak" />
                        </div>
                      }
                    >
                      <img
                        src={attachment.dataUrl}
                        alt={attachment.filename}
                        class="size-16 rounded-md object-cover border border-border-base hover:border-border-strong-base transition-colors"
                        onClick={() =>
                          dialog.show(() => <ImagePreview src={attachment.dataUrl} alt={attachment.filename} />)
                        }
                      />
                    </Show>
                    <button
                      type="button"
                      onClick={() => removeImageAttachment(attachment.id)}
                      class="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-surface-raised-stronger-non-alpha border border-border-base flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-surface-raised-base-hover"
                      aria-label={language.t("prompt.attachment.remove")}
                    >
                      <Icon name="close" class="size-3 text-text-weak" />
                    </button>
                    <div class="absolute bottom-0 left-0 right-0 px-1 py-0.5 bg-black/50 rounded-b-md">
                      <span class="text-10-regular text-white truncate block">{attachment.filename}</span>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
          {/* Companion hands the freed transcript space to the writing surface.
            The dock is bottom-anchored, so a taller cap grows it upward into
            the reachable lower half rather than pushing controls off-thumb.
            Applied at every width — the dock keeps its normal full width. */}
          <div class="contents">
            <div
              classList={{
                "relative overflow-y-auto min-w-0": true,
                "max-h-[240px]": !companionTall(),
                "max-h-[45vh]": companionTall(),
              }}
              ref={(el) => (scrollRef = el)}
            >
              <div
                data-component="prompt-input"
                ref={(el) => {
                  editorRef = el
                  props.ref?.(el)
                }}
                role="textbox"
                aria-multiline="true"
                aria-label={
                  store.mode === "shell"
                    ? language.t("prompt.placeholder.shell")
                    : commentCount() > 1
                      ? language.t("prompt.placeholder.summarizeComments")
                      : commentCount() === 1
                        ? language.t("prompt.placeholder.summarizeComment")
                        : language.t("prompt.placeholder.normal")
                }
                contenteditable="true"
                inputmode="text"
                style={{ "-webkit-transform": "translateZ(0)" }}
                onInput={handleInput}
                onPaste={handlePaste}
                onCompositionStart={() => setComposing(true)}
                onCompositionEnd={() => setComposing(false)}
                onKeyDown={handleKeyDown}
                classList={{
                  "select-text": true,
                  "w-full px-2 text-13-semibold dock-wide:px-3 dock-wide:text-14-semibold text-text-strong focus:outline-none whitespace-pre-wrap": true,
                  "pt-2 pb-0 dock-wide:py-3": !reader(),
                  "pt-2 pb-0 dock-wide:py-2.5": reader(),
                  // The clear button overlays this corner; the first line stops
                  // short of it and the rest of the draft wraps underneath.
                  "pr-9": prompt.dirty(),
                  // Hold the tall surface open on an empty draft, so entering
                  // companion doesn't collapse the dock back to one line.
                  "min-h-[28vh]": companionTall(),
                  "[&_[data-type=file]]:text-syntax-property": true,
                  "[&_[data-type=agent]]:text-syntax-type": true,
                  "font-mono!": store.mode === "shell",
                }}
              />
              <Show when={!prompt.dirty()}>
                <div
                  classList={{
                    "absolute top-0 inset-x-0 px-2 text-13-regular dock-wide:px-3 dock-wide:text-14-regular text-text-weak pointer-events-none whitespace-nowrap truncate": true,
                    // Mirror the editor's vertical padding so the placeholder sits
                    // exactly where typed text will appear.
                    "pt-2 pb-0 dock-wide:py-3": !reader(),
                    "pt-2 pb-0 dock-wide:py-2.5": reader(),
                  }}
                >
                  {store.mode === "shell"
                    ? language.t("prompt.placeholder.shell")
                    : commentCount() > 1
                      ? language.t("prompt.placeholder.summarizeComments")
                      : commentCount() === 1
                        ? language.t("prompt.placeholder.summarizeComment")
                        : language.t("prompt.placeholder.normal")}
                </div>
              </Show>
            </div>
            <div
              classList={{
                // Mobile stacks so the dock info line (when expanded) sits above the
                // flat button row; desktop keeps them side by side.
                "flex flex-col dock-wide:flex-row dock-wide:items-center dock-wide:justify-between gap-2": true,
                "relative px-3 pt-2 pb-1.5 dock-wide:pt-0 dock-wide:py-1.5": true,
              }}
            >
              <div
                classList={{
                  "dock-line1 flex flex-wrap items-center gap-0 min-w-0 flex-1 [&_*]:[font-weight:var(--dock-font-weight)]! [&_*]:[font-size:var(--dock-font-size)]!": true,
                  // Reader drops the model/agent/variant/cwd cluster; only input+attach+submit remain.
                  hidden: reader(),
                  // Mobile: hidden unless the chevron expands it. Desktop always shows.
                  "hidden dock-wide:flex": !reader() && !dockInfoOpen(),
                }}
              >
                {/* Suppressed in favor of the busy-bar above the dock (session.tsx),
                which is now the single busy cue in both modes. Kept (gated false,
                not deleted) so it can be restored by dropping the `false &&`. */}
                <Show when={false && working()}>
                  {/* Busy indicator: the spinner sits ON TOP of a soft, diffuse
                  glow that pulses behind it. Each additional reason the session
                  is busy adds a copy of both layers in its own tint, cross-fading
                  over the base so the color oscillates through all of them. */}
                  <span class="dock-working-indicator mr-2" style={{ "--dock-glow-tint": baseTint() }}>
                    <span data-slot="dock-working-glow" class="dock-working-glow" />
                    <For each={overlays()}>
                      {(tint, index) => (
                        <span
                          data-slot="dock-working-glow"
                          class="dock-working-glow dock-working-glow-overlay"
                          style={{ "--overlay-tint": tint, "animation-delay": busyDelay(index(), overlays().length) }}
                        />
                      )}
                    </For>
                    <Spinner class="dock-working-spinner" style={{ color: baseTint() }} />
                    <For each={overlays()}>
                      {(tint, index) => (
                        <Spinner
                          class="dock-working-spinner dock-working-spinner-overlay"
                          style={{ "--overlay-tint": tint, "animation-delay": busyDelay(index(), overlays().length) }}
                        />
                      )}
                    </For>
                  </span>
                </Show>
                <Switch>
                  <Match when={store.mode === "shell"}>
                    <div class="flex items-center gap-2 px-2 h-6" data-blocked={busy().busySelf ? "true" : undefined}>
                      <Icon
                        name="console"
                        size="small"
                        class={busy().busySelf ? "text-icon-weak" : "text-icon-primary"}
                      />
                      <span class={`text-12-regular ${busy().busySelf ? "text-text-weak" : "text-text-primary"}`}>
                        {language.t("prompt.mode.shell")}
                      </span>
                      <Show when={busy().busySelf}>
                        <span class="text-12-regular text-text-weak">{language.t("prompt.mode.shell.blocked")}</span>
                      </Show>
                      <span class="text-12-regular text-text-weak">{language.t("prompt.mode.shell.exit")}</span>
                    </div>
                  </Match>
                  <Match when={store.mode === "normal"}>
                    <Show when={local.dock.isVisible("agent")}>
                      <TooltipKeybind
                        placement="top"
                        gutter={8}
                        title={language.t("command.agent.cycle")}
                        keybind={command.keybind("agent.cycle")}
                      >
                        <Select
                          options={local.agent.list().map((agent) => agent.name)}
                          current={local.agent.current()?.name ?? ""}
                          onSelect={local.agent.set}
                          class={`capitalize ${local.model.variant.list().length > 0 ? "max-w-[80px]" : "max-w-[120px]"}`}
                          valueClass="truncate text-syntax-type"
                          variant="ghost"
                        />
                      </TooltipKeybind>
                    </Show>
                    <Show when={local.dock.isVisible("model")}>
                      <Show when={local.dock.isVisible("agent")}>
                        <span class="mx-1.5 inline-block size-[4px] rounded-full border border-text-weaker align-middle" />
                      </Show>
                      <Show
                        when={providers.paid().length > 0}
                        fallback={
                          <TooltipKeybind
                            placement="top"
                            gutter={8}
                            title={language.t("command.model.choose")}
                            keybind={command.keybind("model.choose")}
                          >
                            <Button
                              as="div"
                              variant="ghost"
                              class="min-w-0 max-w-[240px]"
                              onClick={() => dialog.show(() => <DialogSelectModelUnpaid />)}
                            >
                              <Show when={local.model.current()?.provider?.id}>
                                <ProviderIcon
                                  id={local.model.current()!.provider.id as IconName}
                                  class="size-4 shrink-0 mr-1 text-text-weak"
                                />
                              </Show>
                              <span class="truncate" style={{ color: "var(--model)" }}>
                                {local.model.current()?.name ?? language.t("dialog.model.select.title")}
                              </span>
                            </Button>
                          </TooltipKeybind>
                        }
                      >
                        <TooltipKeybind
                          placement="top"
                          gutter={8}
                          title={language.t("command.model.choose")}
                          keybind={command.keybind("model.choose")}
                        >
                          <ModelSelectorPopover
                            triggerAs={Button}
                            triggerProps={{ variant: "ghost", class: "min-w-0 max-w-[240px]" }}
                          >
                            <Show when={local.model.current()?.provider?.id}>
                              <ProviderIcon
                                id={local.model.current()!.provider.id as IconName}
                                class="size-4 shrink-0 mr-1 text-text-weak"
                              />
                            </Show>
                            <span class="truncate" style={{ color: "var(--model)" }}>
                              {local.model.current()?.name ?? language.t("dialog.model.select.title")}
                            </span>
                            <Show when={local.model.pendingModel()}>
                              <span
                                class="ml-1 size-1.5 shrink-0 rounded-full bg-icon-interactive-base"
                                title={language.t("model.pending")}
                              />
                            </Show>
                          </ModelSelectorPopover>
                        </TooltipKeybind>
                      </Show>
                    </Show>
                    <Show when={local.dock.isVisible("variant") && local.model.variant.list().length > 0}>
                      <Show when={local.dock.isVisible("agent") || local.dock.isVisible("model")}>
                        <span class="mx-1.5 inline-block size-[4px] rounded-full border border-text-weaker align-middle" />
                      </Show>
                      <TooltipKeybind
                        placement="top"
                        gutter={8}
                        title={language.t("command.model.variant.cycle")}
                        keybind={command.keybind("model.variant.cycle")}
                      >
                        <span class="inline-flex items-center">
                          <Select
                            options={["default", ...local.model.variant.list()]}
                            current={local.model.variant.current() ?? "default"}
                            label={(v) => (v === "default" ? language.t("common.default") : v)}
                            onSelect={(v) => local.model.variant.set(v === "default" ? undefined : v)}
                            class="capitalize max-w-[120px]"
                            valueClass="truncate text-syntax-constant"
                            variant="ghost"
                          />
                          <Show when={local.model.pendingVariant()}>
                            <span
                              class="ml-1 size-1.5 shrink-0 rounded-full bg-icon-interactive-base"
                              title={language.t("model.pending")}
                            />
                          </Show>
                        </span>
                      </TooltipKeybind>
                    </Show>
                  </Match>
                </Switch>
                <Show when={store.mode === "normal" && local.dock.isVisible("cwd")}>
                  <span class="inline-flex min-w-0 items-center text-12-regular leading-tight">
                    <Show
                      when={
                        local.dock.isVisible("agent") ||
                        local.dock.isVisible("model") ||
                        (local.dock.isVisible("variant") && local.model.variant.list().length > 0)
                      }
                    >
                      <span class="mx-1.5 inline-block size-[4px] shrink-0 rounded-full border border-text-weaker align-middle" />
                    </Show>
                    <span
                      class="truncate-start [unicode-bidi:plaintext] min-w-0"
                      style={{ color: "var(--syntax-string)" }}
                    >
                      {dir()}
                    </span>
                    <Show when={local.dock.isVisible("branch") && sync.data.vcs?.branch}>
                      {(branch) => (
                        <span
                          class="ml-1.5 inline-flex shrink-0 items-center gap-1 [&_[data-component=icon]]:!text-current"
                          style={{ color: "var(--branch)" }}
                        >
                          <Icon name="branch" class="size-3.5" />
                          <span class="truncate">{branch()}</span>
                        </span>
                      )}
                    </Show>
                  </span>
                </Show>
              </div>
              <div
                classList={{
                  "flex items-center py-1 dock-wide:flex-none dock-wide:justify-end dock-wide:gap-1 shrink-0": true,
                  // Spreading the icons needs the info cluster opposite them to
                  // push against. Reader hides it, so they group at the end
                  // instead of stretching across the whole dock.
                  "justify-between flex-1": !reader(),
                  "ml-auto gap-1": reader(),
                }}
              >
                {/* Mobile only: grabber toggles the dock info line + chip row
                together (both collapsed by default). Outward arrows = expand;
                inward arrows = collapse. */}
                <Show when={store.mode === "normal" && !reader()}>
                  <Tooltip placement="top" value={dockInfoOpen() ? "Hide session info" : "Show session info"}>
                    <Button
                      type="button"
                      variant="ghost"
                      class={`dock-wide:hidden flex ${companion() ? "size-[calc(var(--control-height)*2)]! [&>[data-component=icon]]:!size-(--control-height)" : ""} items-center justify-center`}
                      onClick={() => setDockInfoOpen((v) => !v)}
                      aria-label={dockInfoOpen() ? "Hide session info" : "Show session info"}
                      aria-expanded={dockInfoOpen()}
                    >
                      <Icon
                        name={dockInfoOpen() ? "chevron-grabber-inward" : "chevron-grabber-vertical"}
                        size="medium"
                      />
                    </Button>
                  </Tooltip>
                </Show>
                {/* Customize configures the dock info line + chip row, so it's only
                useful when those are visible. On mobile it hides while collapsed
                (a display:none span leaves no flex slot, so the row still spreads
                evenly); it's always present on desktop. */}
                <Show when={store.mode === "normal" && !reader()}>
                  <span
                    classList={{
                      contents: dockInfoOpen(),
                      "hidden dock-wide:contents": !dockInfoOpen(),
                    }}
                  >
                    <Tooltip placement="top" value="Customize fields">
                      <Button
                        type="button"
                        variant="ghost"
                        class={`flex ${companion() ? "size-[calc(var(--control-height)*2)]! [&>[data-component=icon]]:!size-(--control-height)" : ""} items-center justify-center`}
                        onClick={() => dialog.show(() => <DialogDock />)}
                        aria-label="Customize fields"
                      >
                        <Icon name="sliders" size="medium" />
                      </Button>
                    </Tooltip>
                  </span>
                </Show>
                <Show
                  when={
                    local.dock.isVisible("auto-accept") && permission.permissionsEnabled() && params.id && !reader()
                  }
                >
                  <span class="contents">
                    <TooltipKeybind
                      placement="top"
                      gutter={8}
                      title={language.t("command.permissions.autoaccept.enable")}
                      keybind={command.keybind("permissions.autoaccept")}
                    >
                      <Button
                        variant="ghost"
                        onClick={() => permission.toggleAutoAccept(params.id!, sdk.directory)}
                        classList={{
                          "flex items-center justify-center": true,
                          "text-text-base": !permission.isAutoAccepting(params.id!, sdk.directory),
                          "hover:bg-surface-success-base": permission.isAutoAccepting(params.id!, sdk.directory),
                        }}
                        aria-label={
                          permission.isAutoAccepting(params.id!, sdk.directory)
                            ? language.t("command.permissions.autoaccept.disable")
                            : language.t("command.permissions.autoaccept.enable")
                        }
                        aria-pressed={permission.isAutoAccepting(params.id!, sdk.directory)}
                      >
                        <Icon
                          name="chevron-double-right"
                          size="small"
                          classList={{
                            "text-icon-success-base": permission.isAutoAccepting(params.id!, sdk.directory),
                          }}
                        />
                      </Button>
                    </TooltipKeybind>
                  </span>
                </Show>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPTED_FILE_TYPES.join(",")}
                  multiple
                  class="hidden"
                  onChange={(e) => {
                    for (const file of Array.from(e.currentTarget.files ?? [])) addImageAttachment(file)
                    e.currentTarget.value = ""
                  }}
                />
                {/* Mobile: contents so keyboard/mic/photo are flat siblings of the
                chevron/customize/send in one justify-between row. Desktop keeps
                them grouped. */}
                <div class="contents dock-wide:flex dock-wide:items-center dock-wide:gap-1 dock-wide:mr-1">
                  <Show when={store.mode === "normal"}>
                    <Tooltip placement="top" value={language.t("prompt.action.attachFile")}>
                      <Button
                        type="button"
                        variant="ghost"
                        class={`${actionButton()} ${actionIcon()}`}
                        onClick={() => fileInputRef.click()}
                        aria-label={language.t("prompt.action.attachFile")}
                      >
                        <Icon name="photo" />
                      </Button>
                    </Tooltip>
                  </Show>
                  <Show when={store.mode === "normal" && dictation.supported()}>
                    <Tooltip
                      placement="top"
                      value={
                        store.dictating ? language.t("prompt.action.dictateStop") : language.t("prompt.action.dictate")
                      }
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        class={`${actionButton()} ${actionIcon()}`}
                        data-dictation-toggle
                        data-dictation-focused={dictationTargeted() ? "" : undefined}
                        onClick={toggleDictation}
                        aria-label={
                          store.dictating
                            ? language.t("prompt.action.dictateStop")
                            : language.t("prompt.action.dictate")
                        }
                        aria-pressed={store.dictating}
                      >
                        <MicIcon running={store.dictating} targeted={dictationTargeted()} />
                      </Button>
                    </Tooltip>
                  </Show>
                </div>
                {/* Stop and Send are separate controls so both can show at once
                (busy WITH a draft): Stop for the running turn, Send to inject
                the draft into it. Send is always rightmost; Stop sits left of
                it when both are present. */}
                <Show when={working()}>
                  <Tooltip
                    placement="top"
                    value={
                      <div class="flex items-center gap-2">
                        <span>{language.t("prompt.action.stop")}</span>
                        <span class="text-icon-base text-12-medium text-[10px]!">{language.t("common.key.esc")}</span>
                      </div>
                    }
                  >
                    <IconButton
                      type="button"
                      icon="stop"
                      variant="primary"
                      // Icon sizes are fixed pixel steps, so a button grown past
                      // the shared control height keeps a glyph scaled for the
                      // smaller one and the square looks lost inside it. These
                      // two size their icon from the button instead, at the same
                      // fraction every other control paints.
                      class={
                        companion()
                          ? "size-[calc(var(--control-height)*2)]! [&>[data-component=icon]]:!size-(--control-height)"
                          : "size-10! any-pointer-coarse:size-11! [&>[data-component=icon]]:!size-6 any-pointer-coarse:[&>[data-component=icon]]:!size-7"
                      }
                      aria-label={language.t("prompt.action.stop")}
                      onClick={abort}
                    />
                  </Tooltip>
                </Show>
                <Show when={!working() || submittable()}>
                  <Tooltip
                    placement="top"
                    inactive={!submittable()}
                    value={
                      <div class="flex items-center gap-2">
                        <span>{language.t("prompt.action.send")}</span>
                        <Icon name="enter" size="small" class="text-icon-base" />
                      </div>
                    }
                  >
                    <IconButton
                      // The native form submit fires this on both a mouse click and
                      // Enter, so handleSubmit needs no click handler of its own.
                      // preserveFocus is what makes that viable on touch: without it
                      // the press blurs the editor to dismiss the soft keyboard, and
                      // on iOS that transition eats the tap before it becomes a click
                      // (the two-tap send). Cancelling the focus shift leaves the
                      // keyboard up and the click intact.
                      type="submit"
                      disabled={!submittable()}
                      icon="arrow-up"
                      variant="primary"
                      // Sized with Stop beside it rather than from the shared
                      // control height: a thumb gets the 44px the guideline
                      // asks for, a mouse keeps the compact 40. The two appear
                      // together whenever a draft is typed into a running turn,
                      // so they take one rule between them.
                      class={
                        companion()
                          ? "size-[calc(var(--control-height)*2)]! [&>[data-component=icon]]:!size-(--control-height)"
                          : "size-10! any-pointer-coarse:size-11! [&>[data-component=icon]]:!size-6 any-pointer-coarse:[&>[data-component=icon]]:!size-7"
                      }
                      aria-label={language.t("prompt.action.send")}
                      {...preserveFocus()}
                    />
                  </Tooltip>
                </Show>
              </div>
            </div>
          </div>
          <Show when={!reader()}>
            <Show
              when={!dockHidden()}
              fallback={
                <div class="border-t border-border-weak-base px-3 py-0.5 flex flex-row items-center justify-end">
                  <Tooltip value={language.t("dock.show")} placement="top" gutter={8}>
                    <IconButton
                      icon="arrow-up"
                      variant="ghost"
                      class="size-(--control-height) p-0"
                      onClick={() => setDockHidden(false)}
                      aria-label={language.t("dock.show")}
                    />
                  </Tooltip>
                </div>
              }
            >
              {/* Chip row: on mobile the grabber collapses it with the info line
                (hidden unless dockInfoOpen); desktop always shows it. The pt-2
                keeps the chips off the divider. Statusline + PromptActionBar are
                direct children (their inner wrappers are display:contents on
                mobile) so every chip group spreads evenly across the width with
                no left/right split. */}
              <div
                classList={{
                  "border-t border-border-weak-base px-3 flex flex-row flex-wrap items-center justify-between gap-1.5": true,
                  "hidden dock-wide:flex": !dockInfoOpen(),
                  "pt-2 pb-0 dock-wide:py-1": true,
                }}
              >
                {/* Statusline is runtime telemetry with nothing to show pre-turn;
                  the action-bar chips (MCP latch especially) matter on a
                  brand-new session, so only the left side gates on a session id. */}
                <Show when={params.id}>
                  <Statusline />
                </Show>
                <PromptActionBar />
              </div>
            </Show>
          </Show>
        </form>
      </div>
    </div>
  )
}

function createTextFragment(content: string): DocumentFragment {
  const fragment = document.createDocumentFragment()
  const segments = content.split("\n")
  segments.forEach((segment, index) => {
    if (segment) {
      fragment.appendChild(document.createTextNode(segment))
    } else if (segments.length > 1) {
      fragment.appendChild(document.createTextNode("\u200B"))
    }
    if (index < segments.length - 1) {
      fragment.appendChild(document.createElement("br"))
    }
  })
  return fragment
}

function getNodeLength(node: Node): number {
  if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "BR") return 1
  return (node.textContent ?? "").replace(/\u200B/g, "").length
}

function getTextLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/\u200B/g, "").length
  if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "BR") return 1
  let length = 0
  for (const child of Array.from(node.childNodes)) {
    length += getTextLength(child)
  }
  return length
}

function getCursorPosition(parent: HTMLElement): number {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return 0
  const range = selection.getRangeAt(0)
  if (!parent.contains(range.startContainer)) return 0
  const preCaretRange = range.cloneRange()
  preCaretRange.selectNodeContents(parent)
  preCaretRange.setEnd(range.startContainer, range.startOffset)
  return getTextLength(preCaretRange.cloneContents())
}

function setCursorPosition(parent: HTMLElement, position: number) {
  let remaining = position
  let node = parent.firstChild
  while (node) {
    const length = getNodeLength(node)
    const isText = node.nodeType === Node.TEXT_NODE
    const isPill =
      node.nodeType === Node.ELEMENT_NODE &&
      ((node as HTMLElement).dataset.type === "file" || (node as HTMLElement).dataset.type === "agent")
    const isBreak = node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "BR"

    if (isText && remaining <= length) {
      const range = document.createRange()
      const selection = window.getSelection()
      range.setStart(node, remaining)
      range.collapse(true)
      selection?.removeAllRanges()
      selection?.addRange(range)
      return
    }

    if ((isPill || isBreak) && remaining <= length) {
      const range = document.createRange()
      const selection = window.getSelection()
      if (remaining === 0) {
        range.setStartBefore(node)
      }
      if (remaining > 0 && isPill) {
        range.setStartAfter(node)
      }
      if (remaining > 0 && isBreak) {
        const next = node.nextSibling
        if (next && next.nodeType === Node.TEXT_NODE) {
          range.setStart(next, 0)
        }
        if (!next || next.nodeType !== Node.TEXT_NODE) {
          range.setStartAfter(node)
        }
      }
      range.collapse(true)
      selection?.removeAllRanges()
      selection?.addRange(range)
      return
    }

    remaining -= length
    node = node.nextSibling
  }

  const fallbackRange = document.createRange()
  const fallbackSelection = window.getSelection()
  const last = parent.lastChild
  if (last && last.nodeType === Node.TEXT_NODE) {
    const len = last.textContent ? last.textContent.length : 0
    fallbackRange.setStart(last, len)
  }
  if (!last || last.nodeType !== Node.TEXT_NODE) {
    fallbackRange.selectNodeContents(parent)
  }
  fallbackRange.collapse(false)
  fallbackSelection?.removeAllRanges()
  fallbackSelection?.addRange(fallbackRange)
}
