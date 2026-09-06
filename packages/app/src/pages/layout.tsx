import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  ParentProps,
  Show,
  Switch,
  untrack,
  type Accessor,
  type JSX,
} from "solid-js"
import { A, useLocation, useNavigate, useParams } from "@solidjs/router"
import { useLayout, getAvatarColors, LocalProject } from "@/context/layout"
import { useGlobalSync } from "@/context/global-sync"
import { Persist, persisted } from "@/utils/persist"
import { base64Encode } from "@opencode-ai/util/encode"
import { decode64 } from "@/utils/base64"
import { Avatar } from "@opencode-ai/ui/avatar"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { InlineInput } from "@opencode-ai/ui/inline-input"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { HoverCard } from "@opencode-ai/ui/hover-card"
import { MessageNav } from "@opencode-ai/ui/message-nav"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Dialog } from "@opencode-ai/ui/dialog"
import { getFilename } from "@opencode-ai/util/path"
import { Session, type Message, type TextPart } from "@opencode-ai/sdk/v2/client"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { createStore, produce, reconcile } from "solid-js/store"
import {
  DragDropProvider,
  DragDropSensors,
  DragOverlay,
  SortableProvider,
  closestCenter,
  createSortable,
} from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { useProviders } from "@/hooks/use-providers"
import { showToast, Toast, toaster } from "@opencode-ai/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { useRecent } from "@/context/recent"
import { attention, busy as busyDot, flat, strongest } from "@/utils/attention"
import { usePermission } from "@/context/permission"
import { Binary } from "@opencode-ai/util/binary"
import { retry } from "@opencode-ai/util/retry"
import { playSound, soundSrc } from "@/utils/sound"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { agentColor } from "@/utils/agent"
import { busyBase, busyDelay, busyOverlays, busyShown } from "@opencode-ai/ui/util/busy-tint"
import { useShell } from "@/utils/mobile"
import { SidebarModeProvider, useSidebarMode } from "@/context/sidebar-mode"

import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useTheme, type ColorScheme } from "@opencode-ai/ui/theme"
import { DialogSelectProvider } from "@/components/dialog-select-provider"
import { DialogSelectServer } from "@/components/dialog-select-server"
import { DialogOverview } from "@/components/dialog-overview"
import { DialogSettings } from "@/components/dialog-settings"
import { useCommand, type CommandOption } from "@/context/command"
import { ConstrainDragXAxis } from "@/utils/solid-dnd"
import { navStart } from "@/utils/perf"
import { DialogSelectDirectory } from "@/components/dialog-select-directory"
import { DialogEditProject } from "@/components/dialog-edit-project"
import { NotificationCenter } from "@/components/notification-center"
import { Titlebar } from "@/components/titlebar"
import { useServer } from "@/context/server"
import { useLanguage } from "@/context/language"

export default function Layout(props: ParentProps) {
  const [store, setStore, , ready] = persisted(
    Persist.global("layout.page", ["layout.page.v1"]),
    createStore({
      activeProject: undefined as string | undefined,
    }),
  )

  const pageReady = createMemo(() => ready())

  let scrollContainerRef: HTMLDivElement | undefined

  const params = useParams()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const layout = useLayout()
  const layoutReady = createMemo(() => layout.ready())
  const platform = usePlatform()
  const settings = useSettings()
  const server = useServer()
  const recent = useRecent()
  const permission = usePermission()
  const navigate = useNavigate()
  const routerLocation = useLocation()
  const providers = useProviders()
  const dialog = useDialog()
  const command = useCommand()
  const theme = useTheme()
  const language = useLanguage()
  const availableThemeEntries = createMemo(() => Object.entries(theme.themes()))
  const colorSchemeOrder: ColorScheme[] = ["system", "light", "dark"]
  const colorSchemeKey: Record<ColorScheme, "theme.scheme.system" | "theme.scheme.light" | "theme.scheme.dark"> = {
    system: "theme.scheme.system",
    light: "theme.scheme.light",
    dark: "theme.scheme.dark",
  }
  const colorSchemeLabel = (scheme: ColorScheme) => language.t(colorSchemeKey[scheme])

  const [state, setState] = createStore({
    busyWorkspaces: new Set<string>(),
    hoverSession: undefined as string | undefined,
    previewProject: undefined as string | undefined,
    scrollSessionKey: undefined as string | undefined,
    nav: undefined as HTMLElement | undefined,
  })

  const [editor, setEditor] = createStore({
    active: "" as string,
    value: "",
  })
  const setBusy = (directory: string, value: boolean) => {
    const key = workspaceKey(directory)
    setState("busyWorkspaces", (prev) => {
      const next = new Set(prev)
      if (value) next.add(key)
      else next.delete(key)
      return next
    })
  }
  const isBusy = (directory: string) => state.busyWorkspaces.has(workspaceKey(directory))
  const editorRef = { current: undefined as HTMLInputElement | undefined }

  // On the collapsed rail the flyout panel is open when a project is previewed.
  const flyoutOpen = createMemo(() => !layout.sidebar.opened() && state.previewProject !== undefined)
  const sidebarExpanded = createMemo(() => layout.sidebar.opened() || flyoutOpen())

  // The project the collapsed-rail flyout is showing (only while collapsed).
  const flyoutProject = createMemo(() => {
    if (layout.sidebar.opened()) return
    const id = state.previewProject
    if (!id) return
    return layout.projects.list().find((project) => project.worktree === id)
  })

  // Closing the overlay sidebar clears the previewed project, so reopening
  // starts on the current project rather than a stale preview. Scoped to its
  // open→close transition: a plain createEffect would also fire where the
  // sidebar docks and never opens as an overlay, wiping every icon click.
  createEffect(
    on(
      () => layout.overlaySidebar.opened(),
      (opened) => {
        if (opened) return
        setState("previewProject", undefined)
      },
      { defer: true },
    ),
  )

  // Navigating (route change) clears any preview so the panel follows the new
  // route rather than the project icon last clicked. It also dismisses the
  // overlay sidebar, which covers the content it just navigated to. Doing it
  // here, on the route change, rather than in each nav handler is what
  // guarantees it closes however the navigation happened.
  createEffect(
    on(
      () => ({ dir: params.dir, id: params.id }),
      () => {
        setState("previewProject", undefined)
        layout.overlaySidebar.hide()
      },
      { defer: true },
    ),
  )

  // Toggling the sidebar between docked and collapsed clears any preview: docking
  // starts the panel on the current route project, and collapsing shows the bare
  // rail (no leftover flyout auto-popping open).
  createEffect(
    on(
      () => layout.sidebar.opened(),
      () => setState("previewProject", undefined),
      { defer: true },
    ),
  )

  // Clicking anywhere outside the collapsed-rail flyout (and its icons)
  // dismisses it. The nav holds both the icons and the flyout panel, so a click
  // there is left alone. A click anywhere else ONLY closes the flyout and is
  // swallowed — it must not trigger whatever sits under the pointer.
  //
  // Scoped to the docked nav, since it keys off state.nav. The overlay sidebar
  // is a separate <nav> with its own backdrop, so its icons are not inside
  // state.nav and every tap on one would read as "outside" and be swallowed.
  createEffect(() => {
    if (layout.overlaySidebar.opened()) return
    if (!flyoutOpen()) return
    const outside = (event: Event) => {
      const target = event.target as Node | null
      return !(target && state.nav?.contains(target))
    }
    const dismiss = (event: PointerEvent) => {
      if (!outside(event)) return
      event.preventDefault()
      event.stopPropagation()
      // Swallow the click that follows this pointerdown so the element under the
      // pointer never receives it — the first outside click only closes the
      // flyout. Registered here (not in the effect body) so tearing down the
      // effect when the flyout closes can't remove it before the click lands.
      const swallow = (click: MouseEvent) => {
        click.preventDefault()
        click.stopPropagation()
        document.removeEventListener("click", swallow, true)
      }
      document.addEventListener("click", swallow, true)
      setState("previewProject", undefined)
    }
    document.addEventListener("pointerdown", dismiss, true)
    onCleanup(() => document.removeEventListener("pointerdown", dismiss, true))
  })

  const editorOpen = (id: string) => editor.active === id
  const editorValue = () => editor.value

  const openEditor = (id: string, value: string) => {
    if (!id) return
    setEditor({ active: id, value })
  }

  const closeEditor = () => setEditor({ active: "", value: "" })

  const saveEditor = (callback: (next: string) => void) => {
    const next = editor.value.trim()
    if (!next) {
      closeEditor()
      return
    }
    closeEditor()
    callback(next)
  }

  const editorKeyDown = (event: KeyboardEvent, callback: (next: string) => void) => {
    if (event.key === "Enter") {
      event.preventDefault()
      saveEditor(callback)
      return
    }
    if (event.key === "Escape") {
      event.preventDefault()
      closeEditor()
    }
  }

  const InlineEditor = (props: {
    id: string
    value: Accessor<string>
    onSave: (next: string) => void
    class?: string
    displayClass?: string
    editing?: boolean
    stopPropagation?: boolean
    openOnDblClick?: boolean
  }) => {
    const isEditing = () => props.editing ?? editorOpen(props.id)
    const stopEvents = () => props.stopPropagation ?? false
    const allowDblClick = () => props.openOnDblClick ?? true
    const stopPropagation = (event: Event) => {
      if (!stopEvents()) return
      event.stopPropagation()
    }
    const handleDblClick = (event: MouseEvent) => {
      if (!allowDblClick()) return
      stopPropagation(event)
      openEditor(props.id, props.value())
    }

    return (
      <Show
        when={isEditing()}
        fallback={
          <span
            class={props.displayClass ?? props.class}
            onDblClick={handleDblClick}
            onPointerDown={stopPropagation}
            onMouseDown={stopPropagation}
            onClick={stopPropagation}
            onTouchStart={stopPropagation}
          >
            {props.value()}
          </span>
        }
      >
        <InlineInput
          ref={(el) => {
            editorRef.current = el
            requestAnimationFrame(() => el.focus())
          }}
          value={editorValue()}
          class={props.class}
          onInput={(event) => setEditor("value", event.currentTarget.value)}
          onKeyDown={(event) => {
            event.stopPropagation()
            editorKeyDown(event, props.onSave)
          }}
          onBlur={() => closeEditor()}
          onPointerDown={stopPropagation}
          onClick={stopPropagation}
          onDblClick={stopPropagation}
          onMouseDown={stopPropagation}
          onMouseUp={stopPropagation}
          onTouchStart={stopPropagation}
        />
      </Show>
    )
  }

  function cycleTheme(direction = 1) {
    const ids = availableThemeEntries().map(([id]) => id)
    if (ids.length === 0) return
    const currentIndex = ids.indexOf(theme.themeId())
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + direction + ids.length) % ids.length
    const nextThemeId = ids[nextIndex]
    theme.setTheme(nextThemeId)
    const nextTheme = theme.themes()[nextThemeId]
    showToast({
      title: language.t("toast.theme.title"),
      description: nextTheme?.name ?? nextThemeId,
    })
  }

  function cycleColorScheme(direction = 1) {
    const current = theme.colorScheme()
    const currentIndex = colorSchemeOrder.indexOf(current)
    const nextIndex =
      currentIndex === -1 ? 0 : (currentIndex + direction + colorSchemeOrder.length) % colorSchemeOrder.length
    const next = colorSchemeOrder[nextIndex]
    theme.setColorScheme(next)
    showToast({
      title: language.t("toast.scheme.title"),
      description: colorSchemeLabel(next),
    })
  }

  onMount(() => {
    if (!platform.checkUpdate || !platform.update || !platform.restart) return

    let toastId: number | undefined
    let interval: ReturnType<typeof setInterval> | undefined

    async function pollUpdate() {
      const { updateAvailable, version } = await platform.checkUpdate!()
      if (updateAvailable && toastId === undefined) {
        toastId = showToast({
          persistent: true,
          icon: "download",
          title: language.t("toast.update.title"),
          description: language.t("toast.update.description", { version: version ?? "" }),
          actions: [
            {
              label: language.t("toast.update.action.installRestart"),
              onClick: async () => {
                await platform.update!()
                await platform.restart!()
              },
            },
            {
              label: language.t("toast.update.action.notYet"),
              onClick: "dismiss",
            },
          ],
        })
      }
    }

    createEffect(() => {
      if (!settings.ready()) return

      if (!settings.updates.startup()) {
        if (interval === undefined) return
        clearInterval(interval)
        interval = undefined
        return
      }

      if (interval !== undefined) return
      void pollUpdate()
      interval = setInterval(pollUpdate, 10 * 60 * 1000)
    })

    onCleanup(() => {
      if (interval === undefined) return
      clearInterval(interval)
    })
  })

  onMount(() => {
    const toastBySession = new Map<string, number>()
    const alertedAtBySession = new Map<string, number>()
    const cooldownMs = 5000

    const unsub = globalSDK.event.listen((e) => {
      if (e.details?.type === "worktree.ready") {
        setBusy(e.name, false)
        WorktreeState.ready(e.name)
        return
      }

      if (e.details?.type === "worktree.failed") {
        setBusy(e.name, false)
        WorktreeState.failed(e.name, e.details.properties?.message ?? language.t("common.requestFailed"))
        return
      }

      // A finished or failed turn is announced, never listed here: the dot it
      // lights lives on the server's recent entry, which every surface reads.
      if (e.details?.type === "session.idle" || e.details?.type === "session.error") {
        const sessionID = e.details.properties.sessionID
        const [syncStore] = globalSync.child(e.name, { bootstrap: false })
        const found = sessionID ? Binary.search(syncStore.session, sessionID, (s) => s.id) : undefined
        const session = sessionID && found?.found ? syncStore.session[found.index] : undefined
        if (session?.parentID) return

        const href = sessionID ? `/${base64Encode(e.name)}/session/${sessionID}` : `/${base64Encode(e.name)}`
        if (e.details.type === "session.idle") {
          playSound(soundSrc(settings.sounds.agent()))
          if (settings.notifications.agent())
            void platform.notify(
              language.t("notification.session.responseReady.title"),
              session?.title ?? sessionID,
              href,
            )
          return
        }

        playSound(soundSrc(settings.sounds.errors()))
        const error = "error" in e.details.properties ? e.details.properties.error : undefined
        if (settings.notifications.errors())
          void platform.notify(
            language.t("notification.session.error.title"),
            session?.title ??
              (typeof error === "string" ? error : language.t("notification.session.error.fallbackDescription")),
            href,
          )
        return
      }

      if (e.details?.type !== "permission.asked" && e.details?.type !== "question.asked") return
      const title =
        e.details.type === "permission.asked"
          ? language.t("notification.permission.title")
          : language.t("notification.question.title")
      const icon = e.details.type === "permission.asked" ? ("checklist" as const) : ("bubble-5" as const)
      const directory = e.name
      const props = e.details.properties
      if (e.details.type === "permission.asked" && permission.autoResponds(e.details.properties, directory)) return

      const [store] = globalSync.child(directory, { bootstrap: false })
      const session = store.session.find((s) => s.id === props.sessionID)
      const sessionKey = `${directory}:${props.sessionID}`

      const sessionTitle = session?.title ?? language.t("command.session.new")
      const projectName = getFilename(directory)
      const description =
        e.details.type === "permission.asked"
          ? language.t("notification.permission.description", { sessionTitle, projectName })
          : language.t("notification.question.description", { sessionTitle, projectName })
      const href = `/${base64Encode(directory)}/session/${props.sessionID}`

      const now = Date.now()
      const lastAlerted = alertedAtBySession.get(sessionKey) ?? 0
      if (now - lastAlerted < cooldownMs) return
      alertedAtBySession.set(sessionKey, now)

      playSound(soundSrc(settings.sounds.blocking()))
      if (settings.notifications.blocking()) void platform.notify(title, description, href)

      const currentDir = decode64(params.dir)
      const currentSession = params.id
      if (directory === currentDir && props.sessionID === currentSession) return
      if (directory === currentDir && session?.parentID === currentSession) return

      const existingToastId = toastBySession.get(sessionKey)
      if (existingToastId !== undefined) toaster.dismiss(existingToastId)

      const toastId = showToast({
        persistent: true,
        icon,
        title,
        description,
        actions: [
          {
            label: language.t("notification.action.goToSession"),
            onClick: () => navigate(href),
          },
          {
            label: language.t("common.dismiss"),
            onClick: "dismiss",
          },
        ],
      })
      toastBySession.set(sessionKey, toastId)
    })
    onCleanup(unsub)

    createEffect(() => {
      const currentDir = decode64(params.dir)
      const currentSession = params.id
      if (!currentDir || !currentSession) return
      const sessionKey = `${currentDir}:${currentSession}`
      const toastId = toastBySession.get(sessionKey)
      if (toastId !== undefined) {
        toaster.dismiss(toastId)
        toastBySession.delete(sessionKey)
        alertedAtBySession.delete(sessionKey)
      }
      const [store] = globalSync.child(currentDir, { bootstrap: false })
      const childSessions = store.session.filter((s) => s.parentID === currentSession)
      for (const child of childSessions) {
        const childKey = `${currentDir}:${child.id}`
        const childToastId = toastBySession.get(childKey)
        if (childToastId !== undefined) {
          toaster.dismiss(childToastId)
          toastBySession.delete(childKey)
          alertedAtBySession.delete(childKey)
        }
      }
    })
  })

  function sortSessions(now: number, directory: string) {
    const oneMinuteAgo = now - 60 * 1000
    return (a: Session, b: Session) => {
      // A working session pins to the top for the whole turn. time.updated is
      // bumped once at turn start and no longer per step (the per-step token/cache
      // writes went lean and skip the bump), so on a turn past 60s the recency
      // tier below would otherwise let a freshly-touched peer overtake the session
      // that is actively working. busyShown is the same predicate the row's own
      // spinner uses (a turn OR a running background job), so a spinning row and
      // its sort position never disagree.
      const aBusy = busyShown(globalSync.busy(directory, a.id))
      const bBusy = busyShown(globalSync.busy(directory, b.id))
      if (aBusy !== bBusy) return aBusy ? -1 : 1
      const aUpdated = a.time.updated ?? a.time.created
      const bUpdated = b.time.updated ?? b.time.created
      const aRecent = aUpdated > oneMinuteAgo
      const bRecent = bUpdated > oneMinuteAgo
      if (aRecent && bRecent) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      if (aRecent && !bRecent) return -1
      if (!aRecent && bRecent) return 1
      return bUpdated - aUpdated
    }
  }

  function scrollToSession(sessionId: string, sessionKey: string) {
    if (!scrollContainerRef) return
    if (state.scrollSessionKey === sessionKey) return
    const element = scrollContainerRef.querySelector(`[data-session-id="${sessionId}"]`)
    if (!element) return
    const containerRect = scrollContainerRef.getBoundingClientRect()
    const elementRect = element.getBoundingClientRect()
    if (elementRect.top >= containerRect.top && elementRect.bottom <= containerRect.bottom) {
      setState("scrollSessionKey", sessionKey)
      return
    }
    setState("scrollSessionKey", sessionKey)
    element.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }

  const currentProject = createMemo(() => {
    const directory = decode64(params.dir)
    if (!directory) return

    return layout.projects.list().find((p) => p.worktree === directory)
  })

  // Clicking a project icon (mobile drawer, or the expanded desktop sidebar)
  // previews its sessions in the panel without navigating. previewProject holds
  // that selection; it falls back to the routed project so the panel opens on
  // the current project.
  const previewProject = createMemo(() => {
    const id = state.previewProject
    const previewed = id ? layout.projects.list().find((p) => p.worktree === id) : undefined
    return previewed ?? currentProject()
  })

  const workspaceKey = (directory: string) => directory.replace(/[\\/]+$/, "")

  // Session lists re-derive on every session.updated (title, seen, summary and
  // other lifecycle fields; the per-step token/cache churn rides lean events
  // that do not carry a full record), but the rendered order rarely moves.
  // Keying the list memos on the ordered id sequence suppresses a new array (and
  // the <For> reconcile it drives) when only the churny fields changed and the
  // order held.
  const sameOrder = (a: Session[], b: Session[]) => a.length === b.length && a.every((s, i) => s.id === b[i].id)

  const currentSessions = createMemo(() => {
    const project = currentProject()
    if (!project) return [] as Session[]
    const compare = sortSessions(Date.now(), project.worktree)
    const [projectStore] = globalSync.child(project.worktree)
    return projectStore.session
      .filter((session) => session.directory === projectStore.path.directory)
      .filter((session) => !session.parentID && !session.time?.archived)
      .toSorted(compare)
  })

  type PrefetchQueue = {
    inflight: Set<string>
    pending: string[]
    pendingSet: Set<string>
    running: number
  }

  // Prefetch buys instant neighbour navigation by holding whole transcripts in
  // the store, each part carrying a Solid store node. A phone pays for that in
  // the one currency it cannot spare: iOS discards a tab on memory pressure, so
  // the reward for a faster swipe is losing the session entirely. Small screens
  // fetch on open instead.
  const compact = useShell().compact
  const prefetchChunk = 200
  const prefetchConcurrency = 1
  const prefetchPendingLimit = 6
  const prefetchToken = { value: 0 }
  const prefetchQueues = new Map<string, PrefetchQueue>()

  const PREFETCH_MAX_SESSIONS_PER_DIR = 10
  const prefetchedByDir = new Map<string, Map<string, true>>()

  const lruFor = (directory: string) => {
    const existing = prefetchedByDir.get(directory)
    if (existing) return existing
    const created = new Map<string, true>()
    prefetchedByDir.set(directory, created)
    return created
  }

  const markPrefetched = (directory: string, sessionID: string) => {
    const lru = lruFor(directory)
    if (lru.has(sessionID)) lru.delete(sessionID)
    lru.set(sessionID, true)
    while (lru.size > PREFETCH_MAX_SESSIONS_PER_DIR) {
      const oldest = lru.keys().next().value as string | undefined
      if (!oldest) return
      lru.delete(oldest)
      const open = untrack(() => params.id)
      if (oldest === open) continue
      const [store, setStore] = globalSync.child(directory, { bootstrap: false })
      globalSync.evictSession(store, setStore, oldest, new Set(open ? [open] : []))
    }
  }

  createEffect(() => {
    params.dir
    globalSDK.url

    prefetchToken.value += 1
    for (const q of prefetchQueues.values()) {
      q.pending.length = 0
      q.pendingSet.clear()
    }
  })

  const queueFor = (directory: string) => {
    const existing = prefetchQueues.get(directory)
    if (existing) return existing

    const created: PrefetchQueue = {
      inflight: new Set(),
      pending: [],
      pendingSet: new Set(),
      running: 0,
    }
    prefetchQueues.set(directory, created)
    return created
  }

  async function prefetchMessages(directory: string, sessionID: string, token: number) {
    const [store, setStore] = globalSync.child(directory, { bootstrap: false })

    return retry(() => globalSDK.client.session.messages({ directory, sessionID, limit: prefetchChunk }))
      .then((messages) => {
        if (prefetchToken.value !== token) return

        const items = (messages.data ?? []).filter((x) => !!x?.info?.id)
        const next = items
          .map((x) => x.info)
          .filter((m) => !!m?.id)
          .slice()
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

        const current = store.message[sessionID] ?? []
        const merged = (() => {
          if (current.length === 0) return next

          const map = new Map<string, Message>()
          for (const item of current) {
            if (!item?.id) continue
            map.set(item.id, item)
          }
          for (const item of next) {
            map.set(item.id, item)
          }
          return [...map.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        })()

        batch(() => {
          setStore("message", sessionID, reconcile(merged, { key: "id" }))

          for (const message of items) {
            const currentParts = store.part[message.info.id] ?? []
            const mergedParts = (() => {
              if (currentParts.length === 0) {
                return message.parts
                  .filter((p) => !!p?.id)
                  .slice()
                  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              }

              const map = new Map<string, (typeof currentParts)[number]>()
              for (const item of currentParts) {
                if (!item?.id) continue
                map.set(item.id, item)
              }
              for (const item of message.parts) {
                if (!item?.id) continue
                map.set(item.id, item)
              }
              return [...map.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            })()

            setStore("part", message.info.id, reconcile(mergedParts, { key: "id" }))
          }
        })
      })
      .catch(() => undefined)
  }

  const pumpPrefetch = (directory: string) => {
    const q = queueFor(directory)
    if (q.running >= prefetchConcurrency) return

    const sessionID = q.pending.shift()
    if (!sessionID) return

    q.pendingSet.delete(sessionID)
    q.inflight.add(sessionID)
    q.running += 1

    const token = prefetchToken.value

    void prefetchMessages(directory, sessionID, token).finally(() => {
      q.running -= 1
      q.inflight.delete(sessionID)
      pumpPrefetch(directory)
    })
  }

  const prefetchSession = (session: Session, priority: "high" | "low" = "low") => {
    const directory = session.directory
    if (!directory) return
    if (compact()) return

    // Never prefetch a live session: its transcript is arriving over SSE, and a
    // full-window refetch reconciles the parts store, clobbering deltas already
    // applied (the streamed first chunk vanishes until the turn's final full-part
    // event heals it). Let SSE own a streaming session's transcript.
    const live = untrack(() =>
      globalSync.data.recent_hub.some((e) => e.sessionID === session.id && globalSync.isAlive(e)),
    )
    if (live) return

    const [store] = globalSync.child(directory, { bootstrap: false })
    const cached = untrack(() => store.message[session.id] !== undefined)
    if (cached) return

    const q = queueFor(directory)
    if (q.inflight.has(session.id)) return
    if (q.pendingSet.has(session.id)) return

    const lru = lruFor(directory)
    const known = lru.has(session.id)
    if (!known && lru.size >= PREFETCH_MAX_SESSIONS_PER_DIR && priority !== "high") return
    markPrefetched(directory, session.id)

    if (priority === "high") q.pending.unshift(session.id)
    if (priority !== "high") q.pending.push(session.id)
    q.pendingSet.add(session.id)

    while (q.pending.length > prefetchPendingLimit) {
      const dropped = q.pending.pop()
      if (!dropped) continue
      q.pendingSet.delete(dropped)
    }

    pumpPrefetch(directory)
  }

  // The sessions to prefetch (list-view neighbors, or the top two on the overview),
  // keyed by identity so this only recomputes when the actual neighbor IDS change.
  // currentSessions churns on every session.updated during a turn (time.updated,
  // cost, title), and prefetching off it re-pulled full 200-message transcripts on
  // that churn. Deriving stable neighbor ids collapses that to one run per real
  // neighbor change.
  const prefetchNeighbors = createMemo(
    () => {
      const sessions = currentSessions()
      const id = params.id
      if (!id) return [sessions[0], sessions[1]].filter((s): s is Session => !!s)
      const index = sessions.findIndex((s) => s.id === id)
      if (index === -1) return [] as Session[]
      return [sessions[index + 1], sessions[index - 1]].filter((s): s is Session => !!s)
    },
    [] as Session[],
    { equals: (a, b) => a.length === b.length && a.every((s, i) => s.id === b[i].id) },
  )

  createEffect(() => {
    for (const session of prefetchNeighbors()) prefetchSession(session)
  })

  function navigateSessionByOffset(offset: number) {
    const sessions = currentSessions()
    if (sessions.length === 0) return

    const sessionIndex = params.id ? sessions.findIndex((s) => s.id === params.id) : -1

    let targetIndex: number
    if (sessionIndex === -1) {
      targetIndex = offset > 0 ? 0 : sessions.length - 1
    } else {
      targetIndex = (sessionIndex + offset + sessions.length) % sessions.length
    }

    const session = sessions[targetIndex]
    if (!session) return

    const next = sessions[(targetIndex + 1) % sessions.length]
    const prev = sessions[(targetIndex - 1 + sessions.length) % sessions.length]

    if (offset > 0) {
      if (next) prefetchSession(next, "high")
      if (prev) prefetchSession(prev)
    }

    if (offset < 0) {
      if (prev) prefetchSession(prev, "high")
      if (next) prefetchSession(next)
    }

    if (import.meta.env.DEV) {
      navStart({
        dir: base64Encode(session.directory),
        from: params.id,
        to: session.id,
        trigger: offset > 0 ? "alt+arrowdown" : "alt+arrowup",
      })
    }
    navigateToSession(session)
    queueMicrotask(() => scrollToSession(session.id, `${session.directory}:${session.id}`))
  }

  function navigateSessionByUnseen(offset: number) {
    const sessions = currentSessions()
    if (sessions.length === 0) return

    const hasUnseen = sessions.some((session) => session.unseen === true)
    if (!hasUnseen) return

    const activeIndex = params.id ? sessions.findIndex((s) => s.id === params.id) : -1
    const start = activeIndex === -1 ? (offset > 0 ? -1 : 0) : activeIndex

    for (let i = 1; i <= sessions.length; i++) {
      const index = offset > 0 ? (start + i) % sessions.length : (start - i + sessions.length) % sessions.length
      const session = sessions[index]
      if (!session) continue
      if (session.unseen !== true) continue

      prefetchSession(session, "high")

      const next = sessions[(index + 1) % sessions.length]
      const prev = sessions[(index - 1 + sessions.length) % sessions.length]

      if (offset > 0) {
        if (next) prefetchSession(next, "high")
        if (prev) prefetchSession(prev)
      }

      if (offset < 0) {
        if (prev) prefetchSession(prev, "high")
        if (next) prefetchSession(next)
      }

      if (import.meta.env.DEV) {
        navStart({
          dir: base64Encode(session.directory),
          from: params.id,
          to: session.id,
          trigger: offset > 0 ? "shift+alt+arrowdown" : "shift+alt+arrowup",
        })
      }

      navigateToSession(session)
      queueMicrotask(() => scrollToSession(session.id, `${session.directory}:${session.id}`))
      return
    }
  }

  async function archiveSession(session: Session) {
    const [store, setStore] = globalSync.child(session.directory)
    const sessions = store.session ?? []
    const index = sessions.findIndex((s) => s.id === session.id)
    const nextSession = sessions[index + 1] ?? sessions[index - 1]

    await globalSDK.client.session.update({
      directory: session.directory,
      sessionID: session.id,
      time: { archived: Date.now() },
    })
    setStore(
      produce((draft) => {
        const match = Binary.search(draft.session, session.id, (s) => s.id)
        if (match.found) draft.session.splice(match.index, 1)
      }),
    )
    if (session.id === params.id) {
      if (nextSession) {
        navigate(`/${params.dir}/session/${nextSession.id}`)
      } else {
        navigate(`/${params.dir}/session`)
      }
    }
  }

  async function deleteSession(session: Session) {
    const [store, setStore] = globalSync.child(session.directory)
    const sessions = (store.session ?? []).filter((s) => !s.parentID && !s.time?.archived)
    const index = sessions.findIndex((s) => s.id === session.id)
    const nextSession = sessions[index + 1] ?? sessions[index - 1]

    const result = await globalSDK.client.session
      .delete({ directory: session.directory, sessionID: session.id })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("session.delete.failed.title"),
          description: errorMessage(err),
        })
        return false
      })

    if (!result) return

    setStore(
      produce((draft) => {
        const removed = new Set<string>([session.id])

        const byParent = new Map<string, string[]>()
        for (const item of draft.session) {
          const parentID = item.parentID
          if (!parentID) continue
          const existing = byParent.get(parentID)
          if (existing) {
            existing.push(item.id)
            continue
          }
          byParent.set(parentID, [item.id])
        }

        const stack = [session.id]
        while (stack.length) {
          const parentID = stack.pop()
          if (!parentID) continue

          const children = byParent.get(parentID)
          if (!children) continue

          for (const child of children) {
            if (removed.has(child)) continue
            removed.add(child)
            stack.push(child)
          }
        }

        draft.session = draft.session.filter((s) => !removed.has(s.id))
      }),
    )

    if (session.id === params.id) {
      if (nextSession) {
        navigate(`/${params.dir}/session/${nextSession.id}`)
      } else {
        navigate(`/${params.dir}/session`)
      }
    }
  }

  command.register(() => {
    const commands: CommandOption[] = [
      {
        id: "sidebar.toggle",
        title: language.t("command.sidebar.toggle"),
        category: language.t("command.category.view"),
        keybind: "mod+b",
        onSelect: () => layout.sidebar.toggle(),
      },
      {
        id: "project.open",
        title: language.t("command.project.open"),
        category: language.t("command.category.project"),
        keybind: "mod+o",
        onSelect: () => chooseProject(),
      },
      {
        id: "provider.connect",
        title: language.t("command.provider.connect"),
        category: language.t("command.category.provider"),
        onSelect: () => connectProvider(),
      },
      {
        id: "server.switch",
        title: language.t("command.server.switch"),
        category: language.t("command.category.server"),
        onSelect: () => openServer(),
      },
      {
        id: "settings.open",
        title: language.t("command.settings.open"),
        category: language.t("command.category.settings"),
        keybind: "mod+comma",
        onSelect: () => openSettings(),
      },
      {
        id: "session.previous",
        title: language.t("command.session.previous"),
        category: language.t("command.category.session"),
        keybind: "alt+arrowup",
        onSelect: () => navigateSessionByOffset(-1),
      },
      {
        id: "session.next",
        title: language.t("command.session.next"),
        category: language.t("command.category.session"),
        keybind: "alt+arrowdown",
        onSelect: () => navigateSessionByOffset(1),
      },
      {
        id: "session.previous.unseen",
        title: language.t("command.session.previous.unseen"),
        category: language.t("command.category.session"),
        keybind: "shift+alt+arrowup",
        onSelect: () => navigateSessionByUnseen(-1),
      },
      {
        id: "session.next.unseen",
        title: language.t("command.session.next.unseen"),
        category: language.t("command.category.session"),
        keybind: "shift+alt+arrowdown",
        onSelect: () => navigateSessionByUnseen(1),
      },
      {
        id: "session.archive",
        title: language.t("command.session.archive"),
        category: language.t("command.category.session"),
        keybind: "mod+shift+backspace",
        disabled: !params.dir || !params.id,
        onSelect: () => {
          const session = currentSessions().find((s) => s.id === params.id)
          if (session) archiveSession(session)
        },
      },
      {
        id: "theme.cycle",
        title: language.t("command.theme.cycle"),
        category: language.t("command.category.theme"),
        keybind: "mod+shift+t",
        onSelect: () => cycleTheme(1),
      },
      {
        id: "attachments.compress.toggle",
        title: settings.attachments.compress()
          ? language.t("command.attachments.compress.off")
          : language.t("command.attachments.compress.on"),
        category: language.t("command.category.settings"),
        onSelect: () => {
          const next = !settings.attachments.compress()
          settings.attachments.setCompress(next)
          showToast({
            title: next
              ? language.t("toast.attachments.compress.enabled.title")
              : language.t("toast.attachments.compress.disabled.title"),
            description: next
              ? language.t("toast.attachments.compress.enabled.description")
              : language.t("toast.attachments.compress.disabled.description"),
          })
        },
      },
    ]

    for (const [id, definition] of availableThemeEntries()) {
      commands.push({
        id: `theme.set.${id}`,
        title: language.t("command.theme.set", { theme: definition.name ?? id }),
        category: language.t("command.category.theme"),
        onSelect: () => theme.commitPreview(),
        onHighlight: () => {
          theme.previewTheme(id)
          return () => theme.cancelPreview()
        },
      })
    }

    // Registered here rather than in the session page so they reach every
    // route: a page that is not a session still needs a way back out of it.
    commands.push(
      {
        id: "jobs.open",
        title: language.t("command.jobs.open"),
        category: language.t("command.category.view"),
        keybind: "alt+j",
        onSelect: () => toggleJobs(),
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
    )

    commands.push({
      id: "theme.scheme.cycle",
      title: language.t("command.theme.scheme.cycle"),
      category: language.t("command.category.theme"),
      keybind: "mod+shift+s",
      onSelect: () => cycleColorScheme(1),
    })

    for (const scheme of colorSchemeOrder) {
      commands.push({
        id: `theme.scheme.${scheme}`,
        title: language.t("command.theme.scheme.set", { scheme: colorSchemeLabel(scheme) }),
        category: language.t("command.category.theme"),
        onSelect: () => theme.commitPreview(),
        onHighlight: () => {
          theme.previewColorScheme(scheme)
          return () => theme.cancelPreview()
        },
      })
    }

    return commands
  })

  // Any dialog that closes without moving focus elsewhere returns the caret to
  // the prompt, so a dismissed dialog never strands focus on the body.
  onMount(() => {
    dialog.setRestore(() => command.trigger("prompt.focus"))
    onCleanup(() => dialog.setRestore(undefined))
  })

  function connectProvider() {
    dialog.show(() => <DialogSelectProvider />)
  }

  function openServer() {
    dialog.show(() => <DialogSelectServer />)
  }

  function openSettings() {
    dialog.show(() => <DialogSettings />)
  }

  // A machine-scoped reading page a reader steps into from a session and
  // expects to come back out of.
  let jobsOrigin: string | undefined
  function toggleJobs() {
    if (routerLocation.pathname.startsWith("/jobs")) {
      const back = jobsOrigin
      jobsOrigin = undefined
      navigate(back ?? "/")
      return
    }
    jobsOrigin = `${routerLocation.pathname}${routerLocation.search}`
    navigate("/jobs")
  }

  function navigateToProject(directory: string | undefined) {
    if (!directory) return
    if (!layout.sidebar.opened()) setState("hoverSession", undefined)
    // Opening a project lands on the sessions list, never a session. Opening a
    // session is a separate, explicit action; project-open must not arm a ping.
    navigate(`/${base64Encode(directory)}`)
    layout.overlaySidebar.hide()
  }

  function navigateToSession(session: Session | undefined) {
    if (!session) return
    if (!layout.sidebar.opened()) setState("hoverSession", undefined)
    navigate(`/${base64Encode(session.directory)}/session/${session.id}`)
    layout.overlaySidebar.hide()
  }

  function openProject(directory: string, navigate = true) {
    layout.projects.open(directory)
    if (navigate) navigateToProject(directory)
  }

  const deepLinkEvent = "opencode:deep-link"

  const parseDeepLink = (input: string) => {
    if (!input.startsWith("opencode://")) return
    const url = new URL(input)
    if (url.hostname !== "open-project") return
    const directory = url.searchParams.get("directory")
    if (!directory) return
    return directory
  }

  const handleDeepLinks = (urls: string[]) => {
    if (!server.isLocal()) return
    for (const input of urls) {
      const directory = parseDeepLink(input)
      if (!directory) continue
      openProject(directory)
    }
  }

  const drainDeepLinks = () => {
    const pending = window.__OPENCODE__?.deepLinks ?? []
    if (pending.length === 0) return
    if (window.__OPENCODE__) window.__OPENCODE__.deepLinks = []
    handleDeepLinks(pending)
  }

  onMount(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ urls: string[] }>).detail
      const urls = detail?.urls ?? []
      if (urls.length === 0) return
      handleDeepLinks(urls)
    }

    drainDeepLinks()
    window.addEventListener(deepLinkEvent, handler as EventListener)
    onCleanup(() => window.removeEventListener(deepLinkEvent, handler as EventListener))
  })

  // Label a project by the shortest meaningful path, mirroring the TUI's
  // directory.ts: collapse a $HOME prefix to "~", otherwise show the absolute
  // path. A user-set name still wins. Identity is the directory now, so the
  // path is the natural label (not just the basename).
  const shortPath = (directory: string) => {
    const home = globalSync.data.path.home
    if (home && (directory === home || directory.startsWith(home + "/"))) return "~" + directory.slice(home.length)
    return directory
  }

  const displayName = (project: LocalProject) => project.name || shortPath(project.worktree)

  async function renameProject(project: LocalProject, next: string) {
    const current = displayName(project)
    if (next === current) return
    const name = next === getFilename(project.worktree) ? "" : next

    if (project.id && project.id !== "global") {
      await globalSDK.client.project.update({ projectID: project.id, directory: project.worktree, name })
      return
    }

    globalSync.project.meta(project.worktree, { name })
  }

  async function renameSession(session: Session, next: string) {
    if (next === session.title) return
    await globalSDK.client.session.update({
      directory: session.directory,
      sessionID: session.id,
      title: next,
    })
  }

  async function finishClose(directory: string) {
    const index = layout.projects.list().findIndex((x) => x.worktree === directory)
    // index === -1 means a concurrent SSE update already dropped this project; a
    // bare index + 1 would land on list()[0], navigating to the first project
    // instead of home. Fall through to navigate("/") in that case.
    const next = index === -1 ? undefined : layout.projects.list()[index + 1]
    const result = await layout.projects.close(directory).catch((err) => {
      showToast({
        title: language.t("project.close.failed.title"),
        description: errorMessage(err),
      })
      return undefined
    })
    if (!result) return
    globalSync.disposeChild(directory)
    if (params.dir && decode64(params.dir) === directory) {
      if (next) navigateToProject(next.worktree)
      else navigate("/")
    }
  }

  function closeProject(directory: string) {
    void finishClose(directory)
  }

  async function chooseProject() {
    function resolve(result: string | string[] | null) {
      const directory = Array.isArray(result) ? result[0] : result
      if (directory) openProject(directory)
    }

    if (platform.openDirectoryPickerDialog && server.isLocal()) {
      const result = await platform.openDirectoryPickerDialog?.({
        title: language.t("command.project.open"),
      })
      resolve(result)
    } else {
      dialog.show(
        () => <DialogSelectDirectory onSelect={resolve} />,
        () => resolve(null),
      )
    }
  }

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const deleteWorkspace = async (root: string, directory: string) => {
    if (directory === root) return

    setBusy(directory, true)

    const result = await globalSDK.client.worktree
      .remove({ directory: root, worktreeRemoveInput: { directory } })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("workspace.delete.failed.title"),
          description: errorMessage(err),
        })
        return false
      })

    setBusy(directory, false)

    if (!result) return

    // The worktree directory is now gone, so unlink its sidebar entry and drop
    // the client child store. Any session still live under it stops on its own;
    // its instance auto-disposes once idle.
    await layout.projects
      .close(directory)
      .then(() => globalSync.disposeChild(directory))
      .catch((err) => {
        showToast({
          title: language.t("project.close.failed.title"),
          description: errorMessage(err),
        })
      })
    layout.projects.open(root)

    if (params.dir && decode64(params.dir) === directory) {
      navigateToProject(root)
    }
  }

  const resetWorkspace = async (root: string, directory: string) => {
    if (directory === root) return
    setBusy(directory, true)

    const progress = showToast({
      persistent: true,
      title: language.t("workspace.resetting.title"),
      description: language.t("workspace.resetting.description"),
    })
    const dismiss = () => toaster.dismiss(progress)

    const sessions = await globalSDK.client.session
      .list({ directory })
      .then((x) => x.data ?? [])
      .catch(() => [])

    const result = await globalSDK.client.worktree
      .reset({ directory: root, worktreeResetInput: { directory } })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("workspace.reset.failed.title"),
          description: errorMessage(err),
        })
        return false
      })

    if (!result) {
      setBusy(directory, false)
      dismiss()
      return
    }

    const archivedAt = Date.now()
    await Promise.all(
      sessions
        .filter((session) => session.time.archived === undefined)
        .map((session) =>
          globalSDK.client.session
            .update({
              sessionID: session.id,
              directory: session.directory,
              time: { archived: archivedAt },
            })
            .catch(() => undefined),
        ),
    )

    await globalSDK.client.instance.dispose({ directory }).catch(() => undefined)

    setBusy(directory, false)
    dismiss()

    showToast({
      title: language.t("workspace.reset.success.title"),
      description: language.t("workspace.reset.success.description"),
      actions: [
        {
          label: language.t("command.session.new"),
          onClick: () => {
            const href = `/${base64Encode(directory)}/session`
            navigate(href)
            layout.overlaySidebar.hide()
          },
        },
        {
          label: language.t("common.dismiss"),
          onClick: "dismiss",
        },
      ],
    })
  }

  function DialogDeleteSession(props: { session: Session }) {
    const handleDelete = async () => {
      await deleteSession(props.session)
      dialog.close()
    }

    return (
      <Dialog title={language.t("session.delete.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">
              {language.t("session.delete.confirm", { name: props.session.title })}
            </span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" onClick={handleDelete}>
              {language.t("session.delete.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  function DialogDeleteWorkspace(props: { root: string; directory: string }) {
    const name = createMemo(() => getFilename(props.directory))
    const [data, setData] = createStore({
      status: "loading" as "loading" | "ready" | "error",
      dirty: false,
    })

    onMount(() => {
      globalSDK.client.file
        .status({ directory: props.directory })
        .then((x) => {
          const files = x.data ?? []
          const dirty = files.length > 0
          setData({ status: "ready", dirty })
        })
        .catch(() => {
          setData({ status: "error", dirty: false })
        })
    })

    const handleDelete = () => {
      dialog.close()
      void deleteWorkspace(props.root, props.directory)
    }

    const description = () => {
      if (data.status === "loading") return language.t("workspace.status.checking")
      if (data.status === "error") return language.t("workspace.status.error")
      if (!data.dirty) return language.t("workspace.status.clean")
      return language.t("workspace.status.dirty")
    }

    return (
      <Dialog title={language.t("workspace.delete.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">
              {language.t("workspace.delete.confirm", { name: name() })}
            </span>
            <span class="text-12-regular text-text-weak">{description()}</span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" disabled={data.status === "loading"} onClick={handleDelete}>
              {language.t("workspace.delete.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  function DialogResetWorkspace(props: { root: string; directory: string }) {
    const name = createMemo(() => getFilename(props.directory))
    const [state, setState] = createStore({
      status: "loading" as "loading" | "ready" | "error",
      dirty: false,
      sessions: [] as Session[],
    })

    const refresh = async () => {
      const sessions = await globalSDK.client.session
        .list({ directory: props.directory })
        .then((x) => x.data ?? [])
        .catch(() => [])
      const active = sessions.filter((session) => session.time.archived === undefined)
      setState({ sessions: active })
    }

    onMount(() => {
      globalSDK.client.file
        .status({ directory: props.directory })
        .then((x) => {
          const files = x.data ?? []
          const dirty = files.length > 0
          setState({ status: "ready", dirty })
          void refresh()
        })
        .catch(() => {
          setState({ status: "error", dirty: false })
        })
    })

    const handleReset = () => {
      dialog.close()
      void resetWorkspace(props.root, props.directory)
    }

    const archivedCount = () => state.sessions.length

    const description = () => {
      if (state.status === "loading") return language.t("workspace.status.checking")
      if (state.status === "error") return language.t("workspace.status.error")
      if (!state.dirty) return language.t("workspace.status.clean")
      return language.t("workspace.status.dirty")
    }

    const archivedLabel = () => {
      const count = archivedCount()
      if (count === 0) return language.t("workspace.reset.archived.none")
      if (count === 1) return language.t("workspace.reset.archived.one")
      return language.t("workspace.reset.archived.many", { count })
    }

    return (
      <Dialog title={language.t("workspace.reset.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">
              {language.t("workspace.reset.confirm", { name: name() })}
            </span>
            <span class="text-12-regular text-text-weak">
              {description()} {archivedLabel()} {language.t("workspace.reset.note")}
            </span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" disabled={state.status === "loading"} onClick={handleReset}>
              {language.t("workspace.reset.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  createEffect(
    on(
      () => ({ ready: pageReady(), dir: params.dir, id: params.id }),
      (value) => {
        if (!value.ready) return
        const dir = value.dir
        const id = value.id
        if (!dir || !id) return
        const directory = decode64(dir)
        if (!directory) return
        void globalSDK.client.session.seen({ directory, sessionID: id })
        requestAnimationFrame(() => scrollToSession(id, `${directory}:${id}`))
      },
      { defer: true },
    ),
  )

  // A turn finishing in the session you are VIEWING marks it unseen server-side.
  // Re-clear it so the active session never lights its own dot; other clients
  // keep the unseen mark until they open it.
  createEffect(() => {
    const id = params.id
    const dir = params.dir
    if (!id || !dir) return
    const directory = decode64(dir)
    if (!directory) return
    const [activeStore] = globalSync.child(directory)
    // Don't mark seen while the session is working (own turn or a subagent) —
    // effective busy from the one operative store.
    if (activeStore.session_busy[id]?.busy) return
    void globalSDK.client.session.seen({ directory, sessionID: id })
  })

  createEffect(() => {
    const project = currentProject()
    if (!project) return
    globalSync.project.loadSessions(project.worktree)
  })

  function getDraggableId(event: unknown): string | undefined {
    if (typeof event !== "object" || event === null) return undefined
    if (!("draggable" in event)) return undefined
    const draggable = (event as { draggable?: { id?: unknown } }).draggable
    if (!draggable) return undefined
    return typeof draggable.id === "string" ? draggable.id : undefined
  }

  function handleDragStart(event: unknown) {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeProject", id)
  }

  function handleDragOver(event: DragEvent) {
    const { draggable, droppable } = event
    if (draggable && droppable) {
      const projects = layout.projects.list()
      const fromIndex = projects.findIndex((p) => p.worktree === draggable.id.toString())
      const toIndex = projects.findIndex((p) => p.worktree === droppable.id.toString())
      if (fromIndex !== toIndex && toIndex !== -1) {
        layout.projects.move(draggable.id.toString(), toIndex)
      }
    }
  }

  function handleDragEnd() {
    setStore("activeProject", undefined)
  }

  const ProjectIcon = (props: { project: LocalProject; class?: string; notify?: boolean }): JSX.Element => {
    // A project's dot is the strongest state across its sessions. Busy is
    // excluded: the rail shows what wants the user, not what is merely running.
    const dotState = createMemo(() =>
      strongest(
        recent
          .attention()
          .concat(recent.recent())
          .filter((row) => row.directory === props.project.worktree)
          .map((row) => attention({ error: row.error, question: row.question, unseen: row.unseen, agent: row.agent })),
      ),
    )
    const name = createMemo(() => props.project.name || getFilename(props.project.worktree))
    // Explicit === false: an absent flag (old client, pre-hydrate) must never
    // read as missing. Only a server-confirmed missing worktree flags red.
    const missing = createMemo(() => props.project.exists === false)

    return (
      <div class={`relative size-8 shrink-0 rounded ${props.class ?? ""}`}>
        <div class="size-full rounded overflow-clip" classList={{ "ring-2 ring-icon-critical-base": missing() }}>
          <Avatar
            fallback={name()}
            src={props.project.icon?.override}
            {...getAvatarColors(props.project.icon?.color)}
            class="size-full rounded"
            classList={{
              "badge-mask": (!!dotState() && !!props.notify) || missing(),
              "opacity-40": missing(),
            }}
          />
        </div>
        <Show when={missing()}>
          <div class="absolute top-px right-px size-1.5 rounded-full z-10 bg-icon-critical-base" />
        </Show>
        <Show when={props.notify && !missing() ? flat(dotState()) : undefined}>
          {(dot) => (
            <div
              class={`absolute top-px right-px size-1.5 rounded-full z-10 ${dot().class}`}
              style={dot().tint ? { "background-color": dot().tint } : undefined}
            />
          )}
        </Show>
      </div>
    )
  }

  const SessionItem = (props: {
    session: Session
    slug: string
    dense?: boolean
    popover?: boolean
    children?: Map<string, string[]>
  }): JSX.Element => {
    const sidebarMode = useSidebarMode()
    const [sessionStore] = globalSync.child(props.session.directory)
    const hasPermissions = createMemo(() => {
      const permissions = sessionStore.permission?.[props.session.id] ?? []
      if (permissions.length > 0) return true

      const childIDs = props.children?.get(props.session.id)
      if (childIDs) {
        for (const id of childIDs) {
          const childPermissions = sessionStore.permission?.[id] ?? []
          if (childPermissions.length > 0) return true
        }
        return false
      }

      const childSessions = sessionStore.session.filter((s) => s.parentID === props.session.id)
      for (const child of childSessions) {
        const childPermissions = sessionStore.permission?.[child.id] ?? []
        if (childPermissions.length > 0) return true
      }
      return false
    })
    // The single operative store carries the three busy facts (effective, own,
    // descendant), rolled up server-side — no local child scan.
    const busyFacts = createMemo(
      () => sessionStore.session_busy[props.session.id] ?? { busy: false, busySelf: false, busyDescendant: false },
    )
    // busyShown also lights for a running background job, which is work this
    // session is waiting on that no turn is executing, so a reader deciding
    // whether to stop the session sees that a result is still coming back.
    const isWorking = createMemo(() => {
      if (hasPermissions()) return false
      return busyShown(busyFacts())
    })

    // Busy renders as the spinner above, so the dot only covers the flat states.
    const dotState = createMemo(() =>
      attention({
        error: recent.get(props.session.id)?.error,
        question: recent.get(props.session.id)?.question,
        permission: hasPermissions(),
        unseen: props.session.unseen === true,
        agent: recent.get(props.session.id)?.agent,
      }),
    )

    const tint = createMemo(() => {
      const messages = sessionStore.message[props.session.id]
      if (!messages) return undefined
      const user = messages
        .slice()
        .reverse()
        .find((m) => m.role === "user")
      if (!user?.agent) return undefined

      const agent = sessionStore.agent.find((a) => a.name === user.agent)
      return agentColor(user.agent, agent?.color)
    })

    const hoverMessages = createMemo(() =>
      sessionStore.message[props.session.id]?.filter((message) => message.role === "user"),
    )
    const hoverReady = createMemo(() => sessionStore.message[props.session.id] !== undefined)
    const hoverAllowed = createMemo(() => !sidebarMode.overlay && sidebarExpanded())
    const hoverEnabled = createMemo(() => (props.popover ?? true) && hoverAllowed())
    const isActive = createMemo(() => props.session.id === params.id)
    const [menu, setMenu] = createStore({
      open: false,
      pendingRename: false,
    })

    const hoverPrefetch = { current: undefined as ReturnType<typeof setTimeout> | undefined }
    const cancelHoverPrefetch = () => {
      if (hoverPrefetch.current === undefined) return
      clearTimeout(hoverPrefetch.current)
      hoverPrefetch.current = undefined
    }
    const scheduleHoverPrefetch = () => {
      if (hoverPrefetch.current !== undefined) return
      hoverPrefetch.current = setTimeout(() => {
        hoverPrefetch.current = undefined
        prefetchSession(props.session)
      }, 200)
    }

    onCleanup(cancelHoverPrefetch)

    const messageLabel = (message: Message) => {
      const parts = sessionStore.part[message.id] ?? []
      const text = parts.find((part): part is TextPart => part?.type === "text" && !part.synthetic && !part.ignored)
      return text?.text
    }

    const item = (
      <A
        href={`${props.slug}/session/${props.session.id}`}
        class={`flex items-center justify-between gap-3 min-w-0 text-left w-full focus:outline-none transition-[padding] ${menu.open ? "pr-7" : ""} group-hover/session:pr-7 group-focus-within/session:pr-7 group-active/session:pr-7 ${props.dense ? "py-0.5" : "py-1"}`}
        onPointerEnter={scheduleHoverPrefetch}
        onPointerLeave={cancelHoverPrefetch}
        onMouseEnter={scheduleHoverPrefetch}
        onMouseLeave={cancelHoverPrefetch}
        onFocus={() => prefetchSession(props.session, "high")}
        onClick={() => {
          setState("hoverSession", undefined)
          // Clicking a sidebar row is an explicit open — declare keep-warm
          // intent so the ping daemon arms. A plain reload/reconnect (which
          // also navigates here) never fires this handler, so it can't arm.
          void globalSDK.client.session.arm({
            sessionID: props.session.id,
            directory: props.session.directory,
          })
          if (layout.sidebar.opened()) return
          queueMicrotask(() => setState("previewProject", undefined))
        }}
      >
        <div class="flex items-center gap-1 w-full">
          <div
            class="shrink-0 size-6 flex items-center justify-center"
            style={{ color: tint() ?? "var(--icon-interactive-base)" }}
          >
            <Switch fallback={<Icon name="dash" size="small" class="text-icon-weak" />}>
              <Match when={isWorking()}>
                <span class="mix-spinner size-[15px]">
                  <Spinner class="size-[15px]" style={{ color: busyBase(busyFacts(), tint()) }} />
                  <For each={busyOverlays(busyFacts(), tint())}>
                    {(overlay, index) => (
                      <Spinner
                        class="mix-spinner-overlay size-[15px]"
                        style={{
                          "--overlay-tint": overlay,
                          "animation-delay": busyDelay(index(), busyOverlays(busyFacts(), tint()).length),
                        }}
                      />
                    )}
                  </For>
                </span>
              </Match>
              <Match when={flat(dotState())}>
                {(dot) => (
                  <div
                    class={`size-1.5 rounded-full ${dot().class}`}
                    style={dot().tint ? { "background-color": dot().tint } : undefined}
                  />
                )}
              </Match>
            </Switch>
          </div>
          <InlineEditor
            id={`session:${props.session.id}`}
            value={() => props.session.title}
            onSave={(next) => renameSession(props.session, next)}
            class="text-14-regular text-text-strong grow-1 min-w-0 overflow-hidden text-ellipsis truncate"
            displayClass="text-14-regular text-text-strong grow-1 min-w-0 overflow-hidden text-ellipsis truncate"
            stopPropagation
          />
          <Show when={props.session.summary}>
            {(summary) => (
              <div class="group-hover/session:hidden group-active/session:hidden group-focus-within/session:hidden">
                <DiffChanges changes={summary()} />
              </div>
            )}
          </Show>
        </div>
      </A>
    )

    return (
      <div
        data-session-id={props.session.id}
        class="group/session relative w-full rounded-md cursor-default transition-colors pl-2 pr-3
               hover:bg-surface-raised-base-hover [&:has(:focus-visible)]:bg-surface-raised-base-hover has-[[data-expanded]]:bg-surface-raised-base-hover has-[.active]:bg-surface-base-active"
      >
        <Show
          when={hoverEnabled()}
          fallback={
            <Tooltip placement={sidebarMode.overlay ? "bottom" : "right"} value={props.session.title} gutter={10}>
              {item}
            </Tooltip>
          }
        >
          <HoverCard
            openDelay={1000}
            closeDelay={flyoutOpen() ? 600 : 0}
            placement="right-start"
            gutter={16}
            shift={-2}
            trigger={item}
            mount={!sidebarMode.overlay ? state.nav : undefined}
            open={state.hoverSession === props.session.id}
            onOpenChange={(open) => setState("hoverSession", open ? props.session.id : undefined)}
          >
            <Show
              when={hoverReady()}
              fallback={<div class="text-12-regular text-text-weak">{language.t("session.messages.loading")}</div>}
            >
              <div class="overflow-y-auto max-h-72 h-full">
                <MessageNav
                  messages={hoverMessages() ?? []}
                  current={undefined}
                  getLabel={messageLabel}
                  onMessageSelect={(message) => {
                    if (!isActive()) {
                      sessionStorage.setItem("opencode.pendingMessage", `${props.session.id}|${message.id}`)
                      navigate(`${props.slug}/session/${props.session.id}`)
                      return
                    }
                    window.history.replaceState(null, "", `#message-${message.id}`)
                    window.dispatchEvent(new HashChangeEvent("hashchange"))
                  }}
                  size="normal"
                  class="w-60"
                />
              </div>
            </Show>
          </HoverCard>
        </Show>
        <div
          class={`absolute ${props.dense ? "top-0.5 right-0.5" : "top-1 right-1"} flex items-center gap-0.5 transition-opacity`}
          classList={{
            "opacity-100 pointer-events-auto": menu.open,
            "opacity-0 pointer-events-none": !menu.open,
            "group-hover/session:opacity-100 group-hover/session:pointer-events-auto": true,
            "group-focus-within/session:opacity-100 group-focus-within/session:pointer-events-auto": true,
          }}
        >
          <DropdownMenu modal={!flyoutOpen()} open={menu.open} onOpenChange={(open) => setMenu("open", open)}>
            <Tooltip value={language.t("common.moreOptions")} placement="top">
              <DropdownMenu.Trigger
                as={IconButton}
                icon="dot-grid"
                variant="ghost"
                class="size-(--control-height) rounded-md data-[expanded]:bg-surface-base-active"
                aria-label={language.t("common.moreOptions")}
              />
            </Tooltip>
            <DropdownMenu.Portal mount={!sidebarMode.overlay ? state.nav : undefined}>
              <DropdownMenu.Content
                onCloseAutoFocus={(event) => {
                  if (!menu.pendingRename) return
                  event.preventDefault()
                  setMenu("pendingRename", false)
                  openEditor(`session:${props.session.id}`, props.session.title)
                }}
              >
                <DropdownMenu.Item
                  onSelect={() => {
                    setMenu("pendingRename", true)
                    setMenu("open", false)
                  }}
                >
                  <DropdownMenu.ItemLabel>{language.t("common.rename")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={() => archiveSession(props.session)}>
                  <DropdownMenu.ItemLabel>{language.t("common.archive")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
                <DropdownMenu.Separator />
                <DropdownMenu.Item onSelect={() => dialog.show(() => <DialogDeleteSession session={props.session} />)}>
                  <DropdownMenu.ItemLabel>{language.t("common.delete")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>
        </div>
      </div>
    )
  }

  const NewSessionItem = (props: { slug: string; dense?: boolean }): JSX.Element => {
    const sidebarMode = useSidebarMode()
    const label = language.t("command.session.new")
    const tooltip = () => sidebarMode.overlay || !sidebarExpanded()
    const item = (
      <A
        href={`${props.slug}/session`}
        end
        class={`flex items-center justify-between gap-3 min-w-0 text-left w-full focus:outline-none ${props.dense ? "py-0.5" : "py-1"}`}
        onClick={() => {
          setState("hoverSession", undefined)
          if (layout.sidebar.opened()) return
          queueMicrotask(() => setState("previewProject", undefined))
        }}
      >
        <div class="flex items-center gap-1 w-full">
          <div class="shrink-0 size-6 flex items-center justify-center">
            <Icon name="plus-small" size="small" class="text-icon-weak" />
          </div>
          <span class="text-14-regular text-text-strong grow-1 min-w-0 overflow-hidden text-ellipsis truncate">
            {label}
          </span>
        </div>
      </A>
    )

    return (
      <div class="group/session relative w-full rounded-md cursor-default transition-colors pl-2 pr-3 hover:bg-surface-raised-base-hover [&:has(:focus-visible)]:bg-surface-raised-base-hover has-[.active]:bg-surface-base-active">
        <Show
          when={!tooltip()}
          fallback={
            <Tooltip placement={sidebarMode.overlay ? "bottom" : "right"} value={label} gutter={10}>
              {item}
            </Tooltip>
          }
        >
          {item}
        </Show>
      </div>
    )
  }

  const SessionSkeleton = (props: { count?: number }): JSX.Element => {
    const items = Array.from({ length: props.count ?? 4 }, (_, index) => index)
    return (
      <div class="flex flex-col gap-1">
        <For each={items}>
          {() => <div class="h-8 w-full rounded-md bg-surface-raised-base opacity-60 animate-pulse" />}
        </For>
      </div>
    )
  }

  const ProjectDragOverlay = (): JSX.Element => {
    const project = createMemo(() => layout.projects.list().find((p) => p.worktree === store.activeProject))
    return (
      <Show when={project()}>
        {(p) => (
          <div class="bg-background-base rounded-xl p-1">
            <ProjectIcon project={p()} />
          </div>
        )}
      </Show>
    )
  }

  const SortableProject = (props: { project: LocalProject }): JSX.Element => {
    const sidebarMode = useSidebarMode()
    const sortable = createSortable(props.project.worktree)
    const selected = createMemo(() => {
      // Mobile drawer and the expanded desktop sidebar highlight the previewed
      // project; the collapsed rail highlights the routed one.
      if (sidebarMode.overlay || layout.sidebar.opened()) return props.project.worktree === previewProject()?.worktree
      const current = decode64(params.dir) ?? ""
      return props.project.worktree === current
    })

    const [menu, setMenu] = createSignal(false)

    // Highlight the icon when its context menu is open, or when the collapsed
    // rail flyout is currently showing this project.
    const active = createMemo(() => menu() || state.previewProject === props.project.worktree)

    // Clicking a project icon only previews its sessions; it never navigates or
    // opens a session. On the collapsed rail a second click on the same icon
    // dismisses the flyout (toggle).
    const handleClick = () => {
      if (!sidebarMode.overlay && !layout.sidebar.opened() && state.previewProject === props.project.worktree) {
        setState("previewProject", undefined)
        return
      }
      globalSync.child(props.project.worktree)
      setState("previewProject", props.project.worktree)
      setState("hoverSession", undefined)
    }

    const projectName = () => props.project.name || getFilename(props.project.worktree)
    const Trigger = () => (
      <ContextMenu modal={!flyoutOpen()} onOpenChange={(value) => setMenu(value)}>
        <ContextMenu.Trigger
          as="button"
          type="button"
          aria-label={projectName()}
          data-action="project-switch"
          data-project={base64Encode(props.project.worktree)}
          classList={{
            "flex items-center justify-center size-10 p-1 rounded-lg overflow-hidden transition-colors cursor-default": true,
            "bg-transparent border-2 border-icon-strong-base hover:bg-surface-base-hover": selected(),
            "bg-transparent border border-transparent hover:bg-surface-base-hover hover:border-border-weak-base":
              !selected() && !active(),
            "bg-surface-base-hover border border-border-weak-base": !selected() && active(),
          }}
          onClick={handleClick}
        >
          <ProjectIcon project={props.project} notify />
        </ContextMenu.Trigger>
        <ContextMenu.Portal mount={!sidebarMode.overlay ? state.nav : undefined}>
          <ContextMenu.Content>
            <ContextMenu.Item onSelect={() => dialog.show(() => <DialogEditProject project={props.project} />)}>
              <ContextMenu.ItemLabel>{language.t("common.edit")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
            <ContextMenu.Separator />
            <ContextMenu.Item
              data-action="project-close-menu"
              data-project={base64Encode(props.project.worktree)}
              onSelect={() => closeProject(props.project.worktree)}
            >
              <ContextMenu.ItemLabel>{language.t("common.close")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu>
    )

    return (
      // @ts-ignore
      <div use:sortable classList={{ "opacity-30": sortable.isActiveDraggable }}>
        <Trigger />
      </div>
    )
  }

  const LocalWorkspace = (props: { project: LocalProject }): JSX.Element => {
    const sidebarMode = useSidebarMode()
    const [workspaceStore, setWorkspaceStore] = globalSync.child(props.project.worktree)
    const slug = createMemo(() => base64Encode(props.project.worktree))
    const sessions = createMemo(
      () =>
        workspaceStore.session
          .filter((session) => session.directory === workspaceStore.path.directory)
          .filter((session) => !session.parentID && !session.time?.archived)
          .toSorted(sortSessions(Date.now(), props.project.worktree)),
      [] as Session[],
      { equals: sameOrder },
    )
    const children = createMemo(() => {
      const map = new Map<string, string[]>()
      for (const session of workspaceStore.session) {
        if (!session.parentID) continue
        const existing = map.get(session.parentID)
        if (existing) {
          existing.push(session.id)
          continue
        }
        map.set(session.parentID, [session.id])
      }
      return map
    })
    const booted = createMemo((prev) => prev || workspaceStore.status === "complete", false)
    const loading = createMemo(() => !booted() && sessions().length === 0)
    const hasMore = createMemo(() => workspaceStore.sessionTotal > sessions().length)
    // Explicit === false so an absent flag never reads as missing (see ProjectIcon).
    const missing = createMemo(() => props.project.exists === false)
    const loadMore = async () => {
      setWorkspaceStore("limit", (limit) => limit + 5)
      await globalSync.project.loadSessions(props.project.worktree)
    }

    return (
      <Show
        when={!missing()}
        fallback={
          <div class="size-full flex flex-col items-center justify-center gap-3 px-6 text-center">
            <div class="flex flex-col gap-1">
              <div class="text-14-medium text-icon-critical-base">{language.t("project.notFound.title")}</div>
              <div class="text-12-regular text-text-weak">{language.t("project.notFound.description")}</div>
            </div>
            <Button
              size="large"
              icon="trash"
              data-action="project-close-notfound"
              data-project={base64Encode(props.project.worktree)}
              onClick={() => closeProject(props.project.worktree)}
            >
              {language.t("common.close")}
            </Button>
          </div>
        }
      >
        <div
          ref={(el) => {
            if (!sidebarMode.overlay) scrollContainerRef = el
          }}
          class="size-full flex flex-col py-2 overflow-y-auto no-scrollbar [overflow-anchor:none]"
        >
          <nav class="flex flex-col gap-1 px-2">
            <Show when={loading()}>
              <SessionSkeleton />
            </Show>
            <For each={sessions()}>
              {(session) => <SessionItem session={session} slug={slug()} children={children()} />}
            </For>
            <Show when={hasMore()}>
              <div class="relative w-full py-1">
                <Button
                  variant="ghost"
                  class="flex w-full text-left justify-start text-14-regular text-text-weak pl-9 pr-10"
                  size="large"
                  onClick={(e: MouseEvent) => {
                    loadMore()
                    ;(e.currentTarget as HTMLButtonElement).blur()
                  }}
                >
                  {language.t("common.loadMore")}
                </Button>
              </div>
            </Show>
          </nav>
        </div>
      </Show>
    )
  }

  const SidebarPanel = (panelProps: { project: LocalProject | undefined }) => {
    const sidebarMode = useSidebarMode()
    const projectName = createMemo(() => {
      const project = panelProps.project
      if (!project) return ""
      return project.name || getFilename(project.worktree)
    })
    const projectId = createMemo(() => panelProps.project?.id ?? "")
    const homedir = createMemo(() => globalSync.data.path.home)

    return (
      <div
        classList={{
          "flex flex-col min-h-0 bg-background-stronger border border-b-0 border-border-weak-base rounded-tl-sm": true,
          "flex-1 min-w-0": sidebarMode.overlay,
        }}
        style={{ width: sidebarMode.overlay ? undefined : `${Math.max(layout.sidebar.width() - 64, 0)}px` }}
      >
        <Show when={panelProps.project}>
          {(p) => (
            <>
              <div class="shrink-0 px-2 py-1">
                <div class="group/project flex items-start justify-between gap-2 p-2 pr-1">
                  <div class="flex flex-col min-w-0">
                    <InlineEditor
                      id={`project:${projectId()}`}
                      value={projectName}
                      onSave={(next) => renameProject(p(), next)}
                      class="text-16-medium text-text-strong truncate"
                      displayClass="text-16-medium text-text-strong truncate"
                      stopPropagation
                    />

                    <Tooltip
                      placement="bottom"
                      gutter={2}
                      value={p().worktree}
                      class="shrink-0"
                      contentStyle={{
                        "max-width": "640px",
                        transform: "translate3d(52px, 0, 0)",
                      }}
                    >
                      <span class="text-12-regular text-text-base truncate select-text">
                        {p().worktree.replace(homedir(), "~")}
                      </span>
                    </Tooltip>
                  </div>

                  <DropdownMenu modal={!flyoutOpen()}>
                    <DropdownMenu.Trigger
                      as={IconButton}
                      icon="dot-grid"
                      variant="ghost"
                      data-action="project-menu"
                      data-project={base64Encode(p().worktree)}
                      class="shrink-0 size-(--control-height) rounded-md opacity-0 group-hover/project:opacity-100 data-[expanded]:opacity-100 data-[expanded]:bg-surface-base-active"
                      aria-label={language.t("common.moreOptions")}
                    />
                    <DropdownMenu.Portal mount={!sidebarMode.overlay ? state.nav : undefined}>
                      <DropdownMenu.Content class="mt-1">
                        <DropdownMenu.Item onSelect={() => dialog.show(() => <DialogEditProject project={p()} />)}>
                          <DropdownMenu.ItemLabel>{language.t("common.edit")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator />
                        <DropdownMenu.Item
                          data-action="project-close-menu"
                          data-project={base64Encode(p().worktree)}
                          onSelect={() => closeProject(p().worktree)}
                        >
                          <DropdownMenu.ItemLabel>{language.t("common.close")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu>
                </div>
              </div>

              <div class="flex-1 min-h-0 flex flex-col">
                <div class="shrink-0 py-4 px-3 flex items-center gap-2">
                  <TooltipKeybind
                    title={language.t("command.session.new")}
                    keybind={command.keybind("session.new")}
                    placement="top"
                    class="flex-1 min-w-0"
                  >
                    <Button
                      size="large"
                      icon="plus-small"
                      class="w-full"
                      onClick={() => {
                        if (!layout.sidebar.opened()) {
                          setState("hoverSession", undefined)
                          setState("previewProject", undefined)
                        }
                        navigate(`/${base64Encode(p().worktree)}/session`)
                        layout.overlaySidebar.hide()
                      }}
                    >
                      {language.t("command.session.new")}
                    </Button>
                  </TooltipKeybind>
                </div>
                <div class="flex-1 min-h-0">
                  <LocalWorkspace project={p()} />
                </div>
              </div>
            </>
          )}
        </Show>

        <div
          class="shrink-0 px-2 py-3 border-t border-border-weak-base"
          classList={{
            hidden: !(providers.all().length > 0 && providers.paid().length === 0),
          }}
        >
          <div class="rounded-md bg-background-base shadow-xs-border-base">
            <div class="p-3 flex flex-col gap-2">
              <div class="text-12-medium text-text-strong">{language.t("sidebar.gettingStarted.title")}</div>
              <div class="text-text-base">{language.t("sidebar.gettingStarted.line1")}</div>
              <div class="text-text-base">{language.t("sidebar.gettingStarted.line2")}</div>
            </div>
            <Button
              class="flex w-full text-left justify-start text-12-medium text-text-strong stroke-[1.5px] rounded-md rounded-t-none shadow-none border-t border-border-weak-base px-3"
              size="large"
              icon="plus"
              onClick={connectProvider}
            >
              {language.t("command.provider.connect")}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  const SidebarContent = () => {
    const sidebarMode = useSidebarMode()
    const expanded = () => sidebarMode.overlay || layout.sidebar.opened()

    return (
      <div class="flex h-full w-full overflow-hidden">
        <div class="w-16 shrink-0 bg-background-base flex flex-col items-center overflow-hidden">
          <div class="flex-1 min-h-0 w-full">
            <DragDropProvider
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragOver={handleDragOver}
              collisionDetector={closestCenter}
            >
              <DragDropSensors />
              <ConstrainDragXAxis />
              {/* In zen the titlebar is gone. When the PWA's window-controls
                  overlay is collapsed the OS controls float in the top corner and
                  the app fills the full height, so the first project would sit
                  under them. env(titlebar-area-height) is the overlay's height in
                  that mode and 0 otherwise (expanded bar / plain browser), so this
                  pad self-detects the collapsed-overlay case and clears it. */}
              <div
                class="h-full w-full flex flex-col items-center gap-3 px-3 py-2 overflow-y-auto no-scrollbar"
                style={{
                  "padding-top": layout.reader.opened() ? "calc(0.5rem + env(titlebar-area-height, 0px))" : undefined,
                }}
              >
                <SortableProvider ids={layout.projects.list().map((p) => p.worktree)}>
                  <For each={layout.projects.list()}>
                    {(project) => <SortableProject project={project} />}
                  </For>
                </SortableProvider>
                <Tooltip
                  placement={sidebarMode.overlay ? "bottom" : "right"}
                  value={
                    <div class="flex items-center gap-2">
                      <span>{language.t("command.project.open")}</span>
                      <Show when={!sidebarMode.overlay}>
                        <span class="text-icon-base text-12-medium">{command.keybind("project.open")}</span>
                      </Show>
                    </div>
                  }
                >
                  <IconButton
                    icon="plus"
                    variant="ghost"
                    size="large"
                    onClick={chooseProject}
                    aria-label={language.t("command.project.open")}
                  />
                </Tooltip>
              </div>
              <DragOverlay>
                <ProjectDragOverlay />
              </DragOverlay>
            </DragDropProvider>
          </div>
          <div class="shrink-0 w-full pt-3 pb-3 flex flex-col items-center gap-2">
            <NotificationCenter />
            <TooltipKeybind
              placement={sidebarMode.overlay ? "bottom" : "right"}
              title={language.t("sidebar.settings")}
              keybind={command.keybind("settings.open")}
            >
              <IconButton
                icon="settings-gear"
                variant="ghost"
                size="large"
                onClick={openSettings}
                aria-label={language.t("sidebar.settings")}
              />
            </TooltipKeybind>
            <Tooltip placement={sidebarMode.overlay ? "bottom" : "right"} value={language.t("sidebar.help")}>
              <IconButton
                icon="help"
                variant="ghost"
                size="large"
                onClick={() => platform.openLink("https://github.com/bhagirathsinh-vaghela/faber/issues")}
                aria-label={language.t("sidebar.help")}
              />
            </Tooltip>
          </div>
        </div>

        {/* Keyed on the project so switching projects recreates the panel (and
            its LocalWorkspace, which subscribes to globalSync.child once at
            creation). Without the key the session list stays bound to the first
            project even though the header updates.
            previewProject() falls back to currentProject(): on a session page
            the drawer opens on that session's project; on the overview (no
            current project) it resolves to undefined, so the mobile drawer
            shows just the bare rail. */}
        <Show when={expanded() ? previewProject() : undefined} keyed>
          {(project) => <SidebarPanel project={project} />}
        </Show>
      </div>
    )
  }

  return (
    <div class="relative bg-background-base flex-1 min-h-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text [&_[data-slot=prompt-dock]]:select-text">
      <Titlebar />
      <div class="flex-1 min-h-0 flex">
        <nav
          aria-label={language.t("sidebar.nav.projectsAndSessions")}
          data-component="sidebar-nav-desktop"
          classList={{
            hidden: true,
            "expanded:block": !layout.reader.opened(),
            "relative shrink-0": true,
          }}
          style={{ width: layout.sidebar.opened() ? `${Math.max(layout.sidebar.width(), 244)}px` : "64px" }}
          ref={(el) => {
            setState("nav", el)
          }}
        >
          <div class="@container w-full h-full contain-strict">
            <SidebarModeProvider>
              <SidebarContent />
            </SidebarModeProvider>
          </div>
          <Show when={flyoutProject()} keyed>
            {(project) => (
              <div data-component="sidebar-flyout" class="absolute inset-y-0 left-16 z-50 flex">
                <SidebarPanel project={project} />
              </div>
            )}
          </Show>
          <Show when={layout.sidebar.opened()}>
            <ResizeHandle
              direction="horizontal"
              size={layout.sidebar.width()}
              min={244}
              max={window.innerWidth * 0.3 + 64}
              collapseThreshold={244}
              onResize={layout.sidebar.resize}
              onCollapse={layout.sidebar.close}
            />
          </Show>
        </nav>
        <div class="expanded:hidden">
          <div
            classList={{
              "fixed inset-x-0 top-[var(--titlebar-height)] bottom-0 z-40 transition-opacity duration-200": true,
              "opacity-100 pointer-events-auto": layout.overlaySidebar.opened(),
              "opacity-0 pointer-events-none": !layout.overlaySidebar.opened(),
            }}
            onClick={(e) => {
              if (e.target === e.currentTarget) layout.overlaySidebar.hide()
            }}
          />
          <nav
            aria-label={language.t("sidebar.nav.projectsAndSessions")}
            data-component="sidebar-nav-mobile"
            classList={{
              "@container fixed top-[var(--titlebar-height)] bottom-0 left-0 z-50 bg-background-base transition-transform duration-200 ease-out": true,
              // Rail-only width when no project panel is showing (overview, no
              // current project); expand to fit the session panel once one is.
              "w-72": previewProject() !== undefined,
              "w-16": previewProject() === undefined,
              "translate-x-0": layout.overlaySidebar.opened(),
              "-translate-x-full": !layout.overlaySidebar.opened(),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <SidebarModeProvider overlay>
              <SidebarContent />
            </SidebarModeProvider>
          </nav>
        </div>

        <main
          classList={{
            "size-full overflow-x-hidden flex flex-col items-start contain-strict border-t border-border-weak-base": true,
            "expanded:border-l expanded:rounded-tl-sm": !layout.sidebar.opened() && !layout.reader.opened(),
          }}
        >
          {props.children}
        </main>
      </div>
      <Toast.Region />
    </div>
  )
}
