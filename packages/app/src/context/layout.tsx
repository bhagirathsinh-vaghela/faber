import { createStore, produce, unwrap } from "solid-js/store"
import { batch, createEffect, createMemo, createSignal, on, onCleanup, onMount, type Accessor } from "solid-js"
import { useLocation } from "@solidjs/router"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useGlobalSync } from "./global-sync"
import { useGlobalSDK } from "./global-sdk"
import { useSettings } from "./settings"
import { Project } from "@opencode-ai/sdk/v2"
import { Persist, persisted, removePersisted } from "@/utils/persist"
import { same } from "@/utils/same"
import { createScrollPersistence, type SessionScroll } from "./layout-scroll"

const AVATAR_COLOR_KEYS = ["pink", "mint", "orange", "purple", "cyan", "lime"] as const
export type AvatarColorKey = (typeof AVATAR_COLOR_KEYS)[number]

export function getAvatarColors(key?: string) {
  if (key && AVATAR_COLOR_KEYS.includes(key as AvatarColorKey)) {
    return {
      background: `var(--avatar-background-${key})`,
      foreground: `var(--avatar-text-${key})`,
    }
  }
  return {
    background: "var(--surface-info-base)",
    foreground: "var(--text-base)",
  }
}

type SessionTabs = {
  active?: string
  all: string[]
}

type SessionView = {
  scroll: Record<string, SessionScroll>
  reviewOpen?: string[]
}

// `exists` originates on the OpenProject sidebar entry (server stats the
// worktree per emit), not the persisted Project record, so it's declared here
// rather than inherited from Project. Absent = unknown/assumed present.
export type LocalProject = Partial<Project> & { worktree: string; exists?: boolean }

export type ReviewDiffStyle = "unified" | "split"

export const { use: useLayout, provider: LayoutProvider } = createSimpleContext({
  name: "Layout",
  init: () => {
    const globalSdk = useGlobalSDK()
    const globalSync = useGlobalSync()
    const settings = useSettings()

    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value)

    const migrate = (value: unknown) => {
      if (!isRecord(value)) return value

      const fileTree = value.fileTree
      const migratedFileTree = (() => {
        if (!isRecord(fileTree)) return fileTree
        if (fileTree.tab === "changes" || fileTree.tab === "all") return fileTree

        const width = typeof fileTree.width === "number" ? fileTree.width : 344
        return {
          ...fileTree,
          opened: true,
          width: width === 260 ? 344 : width,
          tab: "changes",
        }
      })()

      const review = value.review
      const migratedReview = (() => {
        if (!isRecord(review)) return review
        if (!("mobileDiffStyle" in review)) return review
        const { mobileDiffStyle, ...rest } = review
        return { ...rest, narrowDiffStyle: mobileDiffStyle }
      })()

      if (migratedFileTree === fileTree && migratedReview === review) return value
      return {
        ...value,
        fileTree: migratedFileTree,
        review: migratedReview,
      }
    }

    const target = Persist.global("layout", ["layout.v6"])
    const [store, setStore, _, ready] = persisted(
      { ...target, migrate },
      createStore({
        sidebar: {
          opened: false,
          width: 344,
        },
        // Per-client sidebar view state. Which projects are open is server-owned
        // shared state; drag-order is a local view preference, so it lives here,
        // not on the server. projectOrder is a worktree list; unknowns append.
        projectOrder: [] as string[],
        terminal: {
          height: 280,
          opened: false,
        },
        review: {
          diffStyle: "split" as ReviewDiffStyle,
          narrowDiffStyle: "unified" as ReviewDiffStyle,
        },
        fileTree: {
          opened: true,
          width: 344,
          tab: "changes" as "changes" | "all",
        },
        session: {
          width: 600,
        },
        mobileSidebar: {
          opened: false,
        },
        sessionTabs: {} as Record<string, SessionTabs>,
        sessionView: {} as Record<string, SessionView>,
      }),
    )

    const [readerOpened, setReaderOpened] = createSignal(false)

    // Which sessions were left in reader, so leaving one for the overview or
    // reloading the page restores its toggle. Per tab, like the pinned size
    // class: each client decides its own view.
    const readerKey = (session: string) => `opencode.reader.${session}`
    const readerMemory = {
      get: (session: string) => sessionStorage.getItem(readerKey(session)) === "on",
      set: (session: string, opened: boolean) =>
        opened ? sessionStorage.setItem(readerKey(session), "on") : sessionStorage.removeItem(readerKey(session)),
    }

    // Non-sticky interactive: while sticky reader stays on, a temporary composer
    // (plus the exit orb) is overlaid so text can land and be sent without
    // leaving reader. Entered by tap/space/dictation/paste; a submit or clear
    // drops it back to the clean read. Ephemeral, never persisted.
    const [revealed, setRevealed] = createSignal(false)
    const reveal = () => setRevealed(true)
    const unreveal = () => setRevealed(false)

    // Manual expand/collapse of transcript boxes, session id -> box id -> open.
    // Ephemeral, and lifted here for reader's reason: the
    // session page unmounts on the way to the overview, and virtua unmounts a
    // turn scrolled far enough out of view, so state owned by a box cannot
    // outlive either trip.
    const [boxOpen, setBoxOpen] = createStore<Record<string, Record<string, boolean>>>({})

    // Recency is last VISIT, not last toggle, so returning to a session keeps
    // its overrides alive through a long browsing run.
    const MAX_BOX_SESSIONS = 10
    const boxUsed = new Map<string, number>()

    // Enumerating the store's keys inside a tracking scope would subscribe that
    // scope to every session's first write, so the count reads through unwrap.
    function pruneBoxes(keep: string) {
      const sessions = Object.keys(unwrap(boxOpen))
      if (sessions.length <= MAX_BOX_SESSIONS) return

      const score = (session: string) => (session === keep ? Number.MAX_SAFE_INTEGER : (boxUsed.get(session) ?? 0))
      const drop = sessions.sort((a, b) => score(b) - score(a)).slice(MAX_BOX_SESSIONS)

      setBoxOpen(
        produce((draft) => {
          for (const session of drop) delete draft[session]
        }),
      )
      for (const session of drop) boxUsed.delete(session)
    }

    // Focus across the toggle belongs to the session page, which blurs on entry
    // and lands the caret in the composer on exit. Entering sticky reader always
    // starts clean, with no non-sticky composer overlaid.
    const enterReader = () => {
      setReaderOpened(true)
      rememberReader(true)
      setRevealed(false)
      collapseChrome()
    }
    const exitReader = () => {
      setReaderOpened(false)
      rememberReader(false)
      setRevealed(false)
    }

    // Reader strips the chrome around a transcript, so it only means anything on
    // a session route. The overview has no transcript, and reading the raw flag
    // there hid the project rail and titlebar for no gain. Consumers read this
    // gated value rather than the signal.
    const location = useLocation()
    const readerRoute = createMemo(() => /\/session(?:\/([^/?#]+))?/.exec(location.pathname))
    const readerActive = createMemo(() => readerOpened() && readerRoute() !== null)

    // The session on screen, or "new" for the one that has no id until its
    // first message. Undefined anywhere else, which leaves both modes alone.
    const readerSession = createMemo(() => {
      const match = readerRoute()
      if (!match) return undefined
      return match[1] ?? "new"
    })

    const rememberReader = (opened: boolean) => {
      const id = readerRoute()?.[1]
      if (id) readerMemory.set(id, opened)
    }

    const collapseChrome = () => {
      const probe = document.createElement("div")
      probe.style.cssText = "position:absolute;visibility:hidden;height:100lvh"
      document.body.appendChild(probe)
      const large = probe.getBoundingClientRect().height
      probe.style.height = "100svh"
      const small = probe.getBoundingClientRect().height
      probe.remove()
      if (large <= small) return
      // The shell is sticky, so this moves browser chrome and nothing else.
      window.scrollTo({ top: large - small, behavior: "smooth" })
    }

    // A first-seen session always opens interactive: both modes declare that
    // you are not typing into this session, which cannot be decided before its
    // transcript is on screen. Nothing ever writes a memory for the unsaved
    // session, so it opens interactive however the previous one was left.
    // Lives here because the session page unmounts on the way to the overview,
    // the trip this memory has to survive.
    createEffect(
      on(readerSession, (session) => {
        // A non-sticky composer belongs to the session it was raised in, so
        // leaving drops it.
        setRevealed(false)
        if (!session) return
        const next = readerMemory.get(session)
        if (next === readerOpened()) return
        if (next) enterReader()
        else exitReader()
      }),
    )

    const MAX_SESSION_KEYS = 50
    const meta = { active: undefined as string | undefined, pruned: false }
    const used = new Map<string, number>()

    const SESSION_STATE_KEYS = [
      { key: "prompt", legacy: "prompt", version: "v2" },
      { key: "terminal", legacy: "terminal", version: "v1" },
      { key: "file-view", legacy: "file", version: "v1" },
    ] as const

    const dropSessionState = (keys: string[]) => {
      for (const key of keys) {
        const parts = key.split("/")
        const dir = parts[0]
        const session = parts[1]
        if (!dir) continue

        for (const entry of SESSION_STATE_KEYS) {
          const target = session ? Persist.session(dir, session, entry.key) : Persist.workspace(dir, entry.key)
          void removePersisted(target)

          const legacyKey = `${dir}/${entry.legacy}${session ? "/" + session : ""}.${entry.version}`
          void removePersisted({ key: legacyKey })
        }
      }
    }

    function prune(keep?: string) {
      if (!keep) return

      const keys = new Set<string>()
      for (const key of Object.keys(store.sessionView)) keys.add(key)
      for (const key of Object.keys(store.sessionTabs)) keys.add(key)
      if (keys.size <= MAX_SESSION_KEYS) return

      const score = (key: string) => {
        if (key === keep) return Number.MAX_SAFE_INTEGER
        return used.get(key) ?? 0
      }

      const ordered = Array.from(keys).sort((a, b) => score(b) - score(a))
      const drop = ordered.slice(MAX_SESSION_KEYS)
      if (drop.length === 0) return

      setStore(
        produce((draft) => {
          for (const key of drop) {
            delete draft.sessionView[key]
            delete draft.sessionTabs[key]
          }
        }),
      )

      scroll.drop(drop)
      dropSessionState(drop)

      for (const key of drop) {
        used.delete(key)
      }
    }

    function touch(sessionKey: string) {
      meta.active = sessionKey
      used.set(sessionKey, Date.now())

      if (!ready()) return
      if (meta.pruned) return

      meta.pruned = true
      prune(sessionKey)
    }

    const scroll = createScrollPersistence({
      debounceMs: 250,
      getSnapshot: (sessionKey) => store.sessionView[sessionKey]?.scroll,
      onFlush: (sessionKey, next) => {
        const current = store.sessionView[sessionKey]
        const keep = meta.active ?? sessionKey
        if (!current) {
          setStore("sessionView", sessionKey, { scroll: next })
          prune(keep)
          return
        }

        setStore("sessionView", sessionKey, "scroll", (prev) => ({ ...(prev ?? {}), ...next }))
        prune(keep)
      },
    })

    createEffect(() => {
      if (!ready()) return
      if (meta.pruned) return
      const active = meta.active
      if (!active) return
      meta.pruned = true
      prune(active)
    })

    // Always start with the review file-tree panel closed on a fresh load,
    // ignoring the persisted open state. Gated on ready() so it runs after
    // hydration; the once flag keeps it from re-firing on later store writes.
    let fileTreeReset = false
    createEffect(() => {
      if (!ready()) return
      if (fileTreeReset) return
      fileTreeReset = true
      setStore("fileTree", "opened", false)
    })

    onMount(() => {
      const flush = () => batch(() => scroll.flushAll())
      const handleVisibility = () => {
        if (document.visibilityState !== "hidden") return
        flush()
      }

      window.addEventListener("pagehide", flush)
      document.addEventListener("visibilitychange", handleVisibility)

      onCleanup(() => {
        window.removeEventListener("pagehide", flush)
        document.removeEventListener("visibilitychange", handleVisibility)
        scroll.dispose()
      })
    })

    const [colors, setColors] = createStore<Record<string, AvatarColorKey>>({})
    const colorRequested = new Map<string, AvatarColorKey>()

    function pickAvailableColor(used: Set<string>): AvatarColorKey {
      const available = AVATAR_COLOR_KEYS.filter((c) => !used.has(c))
      if (available.length === 0) return AVATAR_COLOR_KEYS[Math.floor(Math.random() * AVATAR_COLOR_KEYS.length)]
      return available[Math.floor(Math.random() * available.length)]
    }

    function enrich(project: { worktree: string; exists?: boolean }) {
      const [childStore] = globalSync.child(project.worktree, { bootstrap: false })
      const projectID = childStore.project
      const metadata = projectID
        ? globalSync.data.project.find((x) => x.id === projectID)
        : globalSync.data.project.find((x) => x.worktree === project.worktree)

      const local = childStore.projectMeta
      const localOverride =
        local?.name !== undefined ||
        local?.commands?.start !== undefined ||
        local?.icon?.override !== undefined ||
        local?.icon?.color !== undefined

      const base = {
        ...(metadata ?? {}),
        ...project,
        icon: {
          url: metadata?.icon?.url,
          override: metadata?.icon?.override ?? childStore.icon,
          color: metadata?.icon?.color,
        },
      }

      const isGlobal = projectID === "global" || (metadata?.id === undefined && localOverride)
      if (!isGlobal) return base

      return {
        ...base,
        id: base.id ?? "global",
        name: local?.name,
        commands: local?.commands,
        icon: {
          url: base.icon?.url,
          override: local?.icon?.override,
          color: local?.icon?.color,
        },
      }
    }

    const ordered = createMemo(() => {
      const open = globalSync.data.open_projects
      const order = store.projectOrder
      const rank = new Map(order.map((worktree, index) => [worktree, index]))
      // A project is its directory (`id`); the entry's `worktree` is only the
      // repo root that bounds discovery, which a subfolder project shares with
      // the repo. The sidebar opens, loads and closes the directory.
      return open
        .map((project) => ({ worktree: project.id, exists: project.exists }))
        .sort((a, b) => (rank.get(a.worktree) ?? order.length) - (rank.get(b.worktree) ?? order.length))
    })

    const enriched = createMemo(() => ordered().map(enrich))
    const list = createMemo(() => {
      const projects = enriched()
      return projects.map((project) => {
        const color = project.icon?.color ?? colors[project.worktree]
        if (!color) return project
        const icon = project.icon ? { ...project.icon, color } : { color }
        return { ...project, icon }
      })
    })

    createEffect(() => {
      const projects = enriched()
      if (projects.length === 0) return
      if (!globalSync.ready) return

      for (const project of projects) {
        if (!project.id) continue
        if (project.id === "global") continue
        globalSync.project.icon(project.worktree, project.icon?.override)
      }
    })

    createEffect(() => {
      const projects = enriched()
      if (projects.length === 0) return

      for (const project of projects) {
        if (project.icon?.color) colorRequested.delete(project.worktree)
      }

      const used = new Set<string>()
      for (const project of projects) {
        const color = project.icon?.color ?? colors[project.worktree]
        if (color) used.add(color)
      }

      for (const project of projects) {
        if (project.icon?.color) continue
        const worktree = project.worktree
        const existing = colors[worktree]
        const color = existing ?? pickAvailableColor(used)
        if (!existing) {
          used.add(color)
          setColors(worktree, color)
        }
        if (!project.id) continue

        const requested = colorRequested.get(worktree)
        if (requested === color) continue
        colorRequested.set(worktree, color)

        if (project.id === "global") {
          globalSync.project.meta(worktree, { icon: { color } })
          continue
        }

        void globalSdk.client.project
          .update({ projectID: project.id, directory: worktree, icon: { color } })
          .catch(() => {
            if (colorRequested.get(worktree) === color) colorRequested.delete(worktree)
          })
      }
    })

    createEffect(() => {
      if (!globalSync.ready) return
      for (const project of globalSync.data.open_projects) globalSync.project.loadSessions(project.id)
    })

    return {
      ready,
      projects: {
        list,
        open(directory: string) {
          globalSync.project.loadSessions(directory)
          return globalSync.project.open(directory)
        },
        close(directory: string) {
          return globalSync.project.close(directory).then((result) => {
            setStore("projectOrder", (order) => order.filter((x) => x !== directory))
            return result
          })
        },
        move(directory: string, toIndex: number) {
          const current = ordered().map((project) => project.worktree)
          const from = current.indexOf(directory)
          if (from === -1) return
          current.splice(toIndex, 0, current.splice(from, 1)[0])
          setStore("projectOrder", current)
        },
      },
      sidebar: {
        opened: createMemo(() => store.sidebar.opened),
        open() {
          setStore("sidebar", "opened", true)
        },
        close() {
          setStore("sidebar", "opened", false)
        },
        toggle() {
          setStore("sidebar", "opened", (x) => !x)
        },
        width: createMemo(() => store.sidebar.width),
        resize(width: number) {
          setStore("sidebar", "width", width)
        },
      },
      terminal: {
        height: createMemo(() => store.terminal.height),
        resize(height: number) {
          setStore("terminal", "height", height)
        },
      },
      review: {
        diffStyle: createMemo(() => store.review?.diffStyle ?? "split"),
        setDiffStyle(diffStyle: ReviewDiffStyle) {
          if (!store.review) {
            setStore("review", { diffStyle })
            return
          }
          setStore("review", "diffStyle", diffStyle)
        },
        narrowDiffStyle: createMemo(() => store.review?.narrowDiffStyle ?? "unified"),
        setNarrowDiffStyle(diffStyle: ReviewDiffStyle) {
          if (!store.review) {
            setStore("review", { narrowDiffStyle: diffStyle })
            return
          }
          setStore("review", "narrowDiffStyle", diffStyle)
        },
      },
      fileTree: {
        opened: createMemo(() => store.fileTree?.opened ?? true),
        width: createMemo(() => store.fileTree?.width ?? 344),
        tab: createMemo(() => store.fileTree?.tab ?? "changes"),
        setTab(tab: "changes" | "all") {
          if (!store.fileTree) {
            setStore("fileTree", { opened: true, width: 344, tab })
            return
          }
          setStore("fileTree", "tab", tab)
        },
        open() {
          if (!store.fileTree) {
            setStore("fileTree", { opened: true, width: 344, tab: "changes" })
            return
          }
          setStore("fileTree", "opened", true)
        },
        close() {
          if (!store.fileTree) {
            setStore("fileTree", { opened: false, width: 344, tab: "changes" })
            return
          }
          setStore("fileTree", "opened", false)
        },
        toggle() {
          if (!store.fileTree) {
            setStore("fileTree", { opened: true, width: 344, tab: "changes" })
            return
          }
          setStore("fileTree", "opened", (x) => !x)
        },
        resize(width: number) {
          if (!store.fileTree) {
            setStore("fileTree", { opened: true, width, tab: "changes" })
            return
          }
          setStore("fileTree", "width", width)
        },
      },
      session: {
        width: createMemo(() => store.session?.width ?? 600),
        resize(width: number) {
          if (!store.session) {
            setStore("session", { width })
            return
          }
          setStore("session", "width", width)
        },
      },
      // Without room to dock, the sidebar is an overlay: it covers the content
      // rather than displacing it, so it dismisses on navigation the way the
      // docked one must not. Tracked apart from `sidebar.opened` because the
      // docked rail stays on screen when closed while this leaves entirely.
      overlaySidebar: {
        opened: createMemo(() => store.mobileSidebar?.opened ?? false),
        show() {
          setStore("mobileSidebar", "opened", true)
        },
        hide() {
          setStore("mobileSidebar", "opened", false)
        },
        toggle() {
          setStore("mobileSidebar", "opened", (x) => !x)
        },
      },
      // Reader mode: hides all chrome (titlebar, tab bar, composer), leaving the
      // scrollable message list, the busy indicator, and any pending question.
      //
      // Two independent flags. `opened` (sticky reader) is the persistent mode.
      // `revealed` (non-sticky) overlays a temporary composer + exit orb WHILE
      // sticky reader stays on, so text can land and be sent without leaving the
      // read. A submit/clear drops the overlay back to the clean read; the exit
      // orb commits up to sticky interactive.
      reader: {
        opened: readerActive,
        enter: enterReader,
        exit: exitReader,
        // The unsaved session getting its id on first submit is a handoff, not
        // an arrival: the mode chosen on the "new" view carries onto the real
        // id. Called by the submit that creates the session, before it
        // navigates, so the restore effect reads the mode back unchanged. The
        // route cannot tell this apart from leaving the new view for any other
        // session, which must not inherit the mode.
        carry: (session: string) => readerMemory.set(session, readerOpened()),
        // The non-sticky composer overlay: raised by a tap, space, dictation, or
        // paste while sticky reader is on.
        revealed,
        reveal,
        // The clean read: reader on with no overlay up. This is the only state
        // that strips the chrome; the non-sticky overlay restores everything a
        // sticky-interactive session shows except the sidebar project rail, so
        // chrome that hides in reader keys on this, not on `opened`.
        cleanRead: createMemo(() => readerActive() && !revealed()),
        // Dropping the overlay back to the clean read, on a submit or clear. A
        // no-op outside the overlay, so a normal interactive submit is untouched.
        returnIfRevealed() {
          if (!revealed()) return
          unreveal()
        },
        // The exit orb: commit up from the non-sticky overlay to sticky
        // interactive, leaving reader entirely.
        exitToInteractive: exitReader,
        toggle() {
          // enterReader/exitReader cannot own this: the restore effect calls
          // them on arrival, where a wipe would hit the session being left.
          const session = readerRoute()?.[1]
          if (session) setBoxOpen(produce((draft) => delete draft[session]))
          if (readerOpened()) exitReader()
          else enterReader()
        },
      },
      // Keyed by session id, not the dir/session composite the persisted stores
      // use, because the boxes reading it live in the ui package and only ever
      // see a session id.
      boxes: {
        open(sessionID: string, boxID: string) {
          return boxOpen[sessionID]?.[boxID]
        },
        setOpen(sessionID: string, boxID: string, open: boolean) {
          boxUsed.set(sessionID, Date.now())
          // Unwrapped: a caller inside an effect (the busy-turn auto-expand)
          // would otherwise subscribe itself to the value it just wrote.
          if (!unwrap(boxOpen)[sessionID]) setBoxOpen(sessionID, { [boxID]: open })
          else setBoxOpen(sessionID, boxID, open)
          pruneBoxes(sessionID)
        },
        touch(sessionID: string) {
          boxUsed.set(sessionID, Date.now())
        },
      },
      view(sessionKey: string | Accessor<string>) {
        const key = typeof sessionKey === "function" ? sessionKey : () => sessionKey

        touch(key())
        scroll.seed(key())

        createEffect(
          on(
            key,
            (value) => {
              touch(value)
              scroll.seed(value)
            },
            { defer: true },
          ),
        )

        const s = createMemo(() => store.sessionView[key()] ?? { scroll: {} })
        const terminalOpened = createMemo(() => store.terminal?.opened ?? false)

        function setTerminalOpened(next: boolean) {
          const current = store.terminal
          if (!current) {
            setStore("terminal", { height: 280, opened: next })
            return
          }

          const value = current.opened ?? false
          if (value === next) return
          setStore("terminal", "opened", next)
        }

        return {
          scroll(tab: string) {
            return scroll.scroll(key(), tab)
          },
          setScroll(tab: string, pos: SessionScroll) {
            scroll.setScroll(key(), tab, pos)
          },
          terminal: {
            opened: terminalOpened,
            open() {
              setTerminalOpened(true)
            },
            close() {
              setTerminalOpened(false)
            },
            toggle() {
              setTerminalOpened(!terminalOpened())
            },
          },
          review: {
            open: createMemo(() => s().reviewOpen),
            setOpen(open: string[]) {
              const session = key()
              const current = store.sessionView[session]
              if (same(current?.reviewOpen, open)) return
              // A session gets its record on first persisted scroll, so a session
              // whose review is opened before it has ever scrolled has none. The
              // store cannot build the intermediate object from a path write, so
              // seed the record whole, the way the scroll flush does.
              if (!current) {
                setStore("sessionView", session, { scroll: {}, reviewOpen: open })
                return
              }
              setStore("sessionView", session, "reviewOpen", open)
            },
          },
        }
      },
      tabs(sessionKey: string | Accessor<string>) {
        const key = typeof sessionKey === "function" ? sessionKey : () => sessionKey

        touch(key())

        createEffect(
          on(
            key,
            (value) => {
              touch(value)
            },
            { defer: true },
          ),
        )

        const tabs = createMemo(() => store.sessionTabs[key()] ?? { all: [] })
        return {
          tabs,
          active: createMemo(() => (tabs().active === "review" ? undefined : tabs().active)),
          all: createMemo(() => tabs().all.filter((tab) => tab !== "review")),
          setActive(tab: string | undefined) {
            const session = key()
            if (tab === "review") return
            if (!store.sessionTabs[session]) {
              setStore("sessionTabs", session, { all: [], active: tab })
            } else {
              setStore("sessionTabs", session, "active", tab)
            }
          },
          setAll(all: string[]) {
            const session = key()
            const next = all.filter((tab) => tab !== "review")
            if (!store.sessionTabs[session]) {
              setStore("sessionTabs", session, { all: next, active: undefined })
            } else {
              setStore("sessionTabs", session, "all", next)
            }
          },
          async open(tab: string) {
            if (tab === "review") return
            const session = key()
            const current = store.sessionTabs[session] ?? { all: [] }

            if (tab === "context") {
              const all = [tab, ...current.all.filter((x) => x !== tab)]
              if (!store.sessionTabs[session]) {
                setStore("sessionTabs", session, { all, active: tab })
                return
              }
              setStore("sessionTabs", session, "all", all)
              setStore("sessionTabs", session, "active", tab)
              return
            }

            if (!current.all.includes(tab)) {
              if (!store.sessionTabs[session]) {
                setStore("sessionTabs", session, { all: [tab], active: tab })
                return
              }
              setStore("sessionTabs", session, "all", [...current.all, tab])
              setStore("sessionTabs", session, "active", tab)
              return
            }

            if (!store.sessionTabs[session]) {
              setStore("sessionTabs", session, { all: current.all, active: tab })
              return
            }
            setStore("sessionTabs", session, "active", tab)
          },
          close(tab: string) {
            const session = key()
            const current = store.sessionTabs[session]
            if (!current) return

            const all = current.all.filter((x) => x !== tab)
            if (current.active !== tab) {
              setStore("sessionTabs", session, "all", all)
              return
            }

            const index = current.all.findIndex((f) => f === tab)
            const next = current.all[index - 1] ?? current.all[index + 1] ?? all[0]
            batch(() => {
              setStore("sessionTabs", session, "all", all)
              setStore("sessionTabs", session, "active", next)
            })
          },
          move(tab: string, to: number) {
            const session = key()
            const current = store.sessionTabs[session]
            if (!current) return
            const index = current.all.findIndex((f) => f === tab)
            if (index === -1) return
            setStore(
              "sessionTabs",
              session,
              "all",
              produce((opened) => {
                opened.splice(to, 0, opened.splice(index, 1)[0])
              }),
            )
          },
        }
      },
    }
  },
})
