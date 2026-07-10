import {
  type Message,
  type Agent,
  type Session,
  type Part,
  type Config,
  type Path,
  type Project,
  type FileDiff,
  type Todo,
  type SessionStatus,
  type ModelPreference,
  type StashEntry,
  type ProviderListResponse,
  type ProviderAuthResponse,
  type Command,
  type McpStatus,
  type LspStatus,
  type VcsInfo,
  type PermissionRequest,
  type QuestionRequest,
  type OpenProject,
  createOpencodeClient,
} from "@opencode-ai/sdk/v2/client"
import { createStore, produce, reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import { Binary } from "@opencode-ai/util/binary"
import { retry } from "@opencode-ai/util/retry"
import { useGlobalSDK } from "./global-sdk"
import type { InitError } from "../pages/error"
import {
  batch,
  createContext,
  createEffect,
  createSignal,
  untrack,
  getOwner,
  runWithOwner,
  useContext,
  onCleanup,
  onMount,
  type Accessor,
  type ParentProps,
  Switch,
  Match,
} from "solid-js"
import { showToast } from "@opencode-ai/ui/toast"
import { getFilename } from "@opencode-ai/util/path"
import { usePlatform } from "./platform"
import { useLanguage } from "@/context/language"
import { Persist, persisted } from "@/utils/persist"

type ProjectMeta = {
  name?: string
  icon?: {
    override?: string
    color?: string
  }
  commands?: {
    start?: string
  }
}

type State = {
  status: "loading" | "partial" | "complete"
  agent: Agent[]
  command: Command[]
  project: string
  projectMeta: ProjectMeta | undefined
  icon: string | undefined
  provider: ProviderListResponse
  config: Config
  path: Path
  // Global server-owned UI preferences, persisted on the server and streamed to
  // every client so all tabs stay in sync.
  model_preference: ModelPreference
  stash: StashEntry[]
  session: Session[]
  sessionTotal: number
  session_status: {
    [sessionID: string]: SessionStatus
  }
  // Session IDs whose ping daemon is armed on this server instance. The hub's
  // will-ping countdown is gated on this, never on the persisted cache anchor
  // (which outlives the daemon across a restart).
  ping_armed: {
    [sessionID: string]: boolean
  }
  // Session IDs with auto-accept edits enabled on this server instance. The
  // server resolves edit asks itself when set, so this streams to every client
  // instead of living in one browser's local storage.
  auto_accept: {
    [sessionID: string]: boolean
  }
  session_diff: {
    [sessionID: string]: FileDiff[]
  }
  todo: {
    [sessionID: string]: Todo[]
  }
  permission: {
    [sessionID: string]: PermissionRequest[]
  }
  question: {
    [sessionID: string]: QuestionRequest[]
  }
  mcp: {
    [name: string]: McpStatus
  }
  lsp: LspStatus[]
  vcs: VcsInfo | undefined
  limit: number
  message: {
    [sessionID: string]: Message[]
  }
  part: {
    [messageID: string]: Part[]
  }
}

type VcsCache = {
  store: Store<{ value: VcsInfo | undefined }>
  setStore: SetStoreFunction<{ value: VcsInfo | undefined }>
  ready: Accessor<boolean>
}

type MetaCache = {
  store: Store<{ value: ProjectMeta | undefined }>
  setStore: SetStoreFunction<{ value: ProjectMeta | undefined }>
  ready: Accessor<boolean>
}

type IconCache = {
  store: Store<{ value: string | undefined }>
  setStore: SetStoreFunction<{ value: string | undefined }>
  ready: Accessor<boolean>
}

type ChildOptions = {
  bootstrap?: boolean
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function normalizeProviderList(input: ProviderListResponse): ProviderListResponse {
  return {
    ...input,
    all: input.all.map((provider) => ({
      ...provider,
      models: Object.fromEntries(Object.entries(provider.models).filter(([, info]) => info.status !== "deprecated")),
    })),
  }
}

function createGlobalSync() {
  const globalSDK = useGlobalSDK()
  const platform = usePlatform()
  const language = useLanguage()
  const owner = getOwner()
  if (!owner) throw new Error("GlobalSync must be created within owner")
  const vcsCache = new Map<string, VcsCache>()
  const metaCache = new Map<string, MetaCache>()
  const iconCache = new Map<string, IconCache>()

  const sdkCache = new Map<string, ReturnType<typeof createOpencodeClient>>()
  const sdkFor = (directory: string) => {
    const cached = sdkCache.get(directory)
    if (cached) return cached

    const sdk = createOpencodeClient({
      baseUrl: globalSDK.url,
      fetch: platform.fetch,
      directory,
      throwOnError: true,
    })
    sdkCache.set(directory, sdk)
    return sdk
  }

  const [projectCache, setProjectCache, , projectCacheReady] = persisted(
    Persist.global("globalSync.project", ["globalSync.project.v1"]),
    createStore({ value: [] as Project[] }),
  )

  const sanitizeProject = (project: Project) => {
    if (!project.icon?.url && !project.icon?.override) return project
    return {
      ...project,
      icon: {
        ...project.icon,
        url: undefined,
        override: undefined,
      },
    }
  }
  const [globalStore, setGlobalStore] = createStore<{
    ready: boolean
    error?: InitError
    path: Path
    project: Project[]
    provider: ProviderListResponse
    provider_auth: ProviderAuthResponse
    config: Config
    model_preference: ModelPreference
    stash: StashEntry[]
    reload: undefined | "pending" | "complete"
    // The complete home overview, server-owned so every client renders the same
    // list without opening any directory. Seeded once at bootstrap, then replaced
    // wholesale from the recent.updated event (which carries the full list). Each
    // entry already carries its live flags (busy, unseen) and next-ping deadline;
    // the client only ticks the deadline into a countdown string.
    recent_hub: {
      sessionID: string
      directory: string
      title: string
      updated: number
      busy: boolean
      unseen: boolean
      pingAt?: number
    }[]
    // The server-owned set of projects shown in the sidebar. Every client
    // connected to this server renders the same set: seeded at bootstrap from
    // GET /global/projects/open, then replaced wholesale from the
    // open-projects.updated event (full-list snapshot). Which projects are
    // open is shared truth; per-client view state (expand/collapse) stays local.
    open_projects: OpenProject[]
  }>({
    ready: false,
    path: { state: "", config: "", worktree: "", directory: "", home: "" },
    project: projectCache.value,
    provider: { all: [], connected: [], default: {} },
    provider_auth: {},
    config: {},
    model_preference: { user: [], recent: [], variant: {} },
    stash: [],
    reload: undefined,
    recent_hub: [],
    open_projects: [],
  })

  // Bumped on every (re)attach of the event stream. Open sessions subscribe to
  // heal messages/parts that arrived during the disconnect window (no SSE replay).
  const [reconnect, setReconnect] = createSignal(0)

  const queued = new Set<string>()
  let root = false
  let running = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const paused = () => untrack(() => globalStore.reload) !== undefined

  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  const take = (count: number) => {
    if (queued.size === 0) return [] as string[]
    const items: string[] = []
    for (const item of queued) {
      queued.delete(item)
      items.push(item)
      if (items.length >= count) break
    }
    return items
  }

  const schedule = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      void drain()
    }, 0)
  }

  const push = (directory: string) => {
    if (!directory) return
    queued.add(directory)
    if (paused()) return
    schedule()
  }

  const refresh = () => {
    root = true
    if (paused()) return
    schedule()
  }

  async function drain() {
    if (running) return
    running = true
    try {
      while (true) {
        if (paused()) return

        if (root) {
          root = false
          await bootstrap()
          await tick()
          continue
        }

        const dirs = take(2)
        if (dirs.length === 0) return

        await Promise.all(dirs.map((dir) => bootstrapInstance(dir)))
        await tick()
      }
    } finally {
      running = false
      if (paused()) return
      if (root || queued.size) schedule()
    }
  }

  createEffect(() => {
    if (!projectCacheReady()) return
    if (globalStore.project.length !== 0) return
    const cached = projectCache.value
    if (cached.length === 0) return
    setGlobalStore("project", cached)
  })

  createEffect(() => {
    if (!projectCacheReady()) return
    const projects = globalStore.project
    if (projects.length === 0) {
      const cachedLength = untrack(() => projectCache.value.length)
      if (cachedLength !== 0) return
    }
    setProjectCache("value", projects.map(sanitizeProject))
  })

  createEffect(() => {
    if (globalStore.reload !== "complete") return
    setGlobalStore("reload", undefined)
    refresh()
  })

  const children: Record<string, [Store<State>, SetStoreFunction<State>]> = {}
  const booting = new Map<string, Promise<void>>()
  const sessionLoads = new Map<string, Promise<void>>()
  const sessionMeta = new Map<string, { limit: number }>()

  const sessionRecentWindow = 4 * 60 * 60 * 1000
  const sessionRecentLimit = 50

  function sessionUpdatedAt(session: Session) {
    return session.time.updated ?? session.time.created
  }

  function compareSessionRecent(a: Session, b: Session) {
    const aUpdated = sessionUpdatedAt(a)
    const bUpdated = sessionUpdatedAt(b)
    if (aUpdated !== bUpdated) return bUpdated - aUpdated
    return cmp(a.id, b.id)
  }

  function takeRecentSessions(sessions: Session[], limit: number, cutoff: number) {
    if (limit <= 0) return [] as Session[]
    const selected: Session[] = []
    const seen = new Set<string>()
    for (const session of sessions) {
      if (!session?.id) continue
      if (seen.has(session.id)) continue
      seen.add(session.id)

      if (sessionUpdatedAt(session) <= cutoff) continue

      const index = selected.findIndex((x) => compareSessionRecent(session, x) < 0)
      if (index === -1) selected.push(session)
      if (index !== -1) selected.splice(index, 0, session)
      if (selected.length > limit) selected.pop()
    }
    return selected
  }

  function trimSessions(input: Session[], options: { limit: number; permission: Record<string, PermissionRequest[]> }) {
    const limit = Math.max(0, options.limit)
    const cutoff = Date.now() - sessionRecentWindow
    const all = input
      .filter((s) => !!s?.id)
      .filter((s) => !s.time?.archived)
      .sort((a, b) => cmp(a.id, b.id))

    const roots = all.filter((s) => !s.parentID)
    const children = all.filter((s) => !!s.parentID)

    const base = roots.slice(0, limit)
    const recent = takeRecentSessions(roots.slice(limit), sessionRecentLimit, cutoff)
    const keepRoots = [...base, ...recent]

    const keepRootIds = new Set(keepRoots.map((s) => s.id))
    const keepChildren = children.filter((s) => {
      if (s.parentID && keepRootIds.has(s.parentID)) return true
      const perms = options.permission[s.id] ?? []
      if (perms.length > 0) return true
      return sessionUpdatedAt(s) > cutoff
    })

    return [...keepRoots, ...keepChildren].sort((a, b) => cmp(a.id, b.id))
  }

  function ensureChild(directory: string) {
    if (!directory) console.error("No directory provided")
    if (!children[directory]) {
      const vcs = runWithOwner(owner, () =>
        persisted(
          Persist.workspace(directory, "vcs", ["vcs.v1"]),
          createStore({ value: undefined as VcsInfo | undefined }),
        ),
      )
      if (!vcs) throw new Error("Failed to create persisted cache")
      const vcsStore = vcs[0]
      const vcsReady = vcs[3]
      vcsCache.set(directory, { store: vcsStore, setStore: vcs[1], ready: vcsReady })

      const meta = runWithOwner(owner, () =>
        persisted(
          Persist.workspace(directory, "project", ["project.v1"]),
          createStore({ value: undefined as ProjectMeta | undefined }),
        ),
      )
      if (!meta) throw new Error("Failed to create persisted project metadata")
      metaCache.set(directory, { store: meta[0], setStore: meta[1], ready: meta[3] })

      const icon = runWithOwner(owner, () =>
        persisted(
          Persist.workspace(directory, "icon", ["icon.v1"]),
          createStore({ value: undefined as string | undefined }),
        ),
      )
      if (!icon) throw new Error("Failed to create persisted project icon")
      iconCache.set(directory, { store: icon[0], setStore: icon[1], ready: icon[3] })

      const init = () => {
        const child = createStore<State>({
          project: "",
          projectMeta: meta[0].value,
          icon: icon[0].value,
          provider: { all: [], connected: [], default: {} },
          config: {},
          path: { state: "", config: "", worktree: "", directory: "", home: "" },
          model_preference: { user: [], recent: [], variant: {} },
          stash: [],
          status: "loading" as const,
          agent: [],
          command: [],
          session: [],
          sessionTotal: 0,
          session_status: {},
          ping_armed: {},
          auto_accept: {},
          session_diff: {},
          todo: {},
          permission: {},
          question: {},
          mcp: {},
          lsp: [],
          vcs: vcsStore.value,
          limit: 5,
          message: {},
          part: {},
        })

        children[directory] = child

        createEffect(() => {
          if (!vcsReady()) return
          const cached = vcsStore.value
          if (!cached?.branch) return
          child[1]("vcs", (value) => value ?? cached)
        })

        createEffect(() => {
          child[1]("projectMeta", meta[0].value)
        })

        createEffect(() => {
          child[1]("icon", icon[0].value)
        })
      }

      runWithOwner(owner, init)
    }
    const childStore = children[directory]
    if (!childStore) throw new Error("Failed to create store")
    return childStore
  }

  function child(directory: string, options: ChildOptions = {}) {
    const childStore = ensureChild(directory)
    const shouldBootstrap = options.bootstrap ?? true
    if (shouldBootstrap && childStore[0].status === "loading") {
      void bootstrapInstance(directory)
    }
    return childStore
  }

  // Drop all in-memory per-directory state so a closed project stops consuming
  // memory and stops receiving SSE dispatch (the event switch drops events for
  // a directory with no child store). The reverse of ensureChild. Distinct from
  // the server.instance.disposed handler, which re-bootstraps — this tears down.
  function disposeChild(directory: string) {
    delete children[directory]
    vcsCache.delete(directory)
    metaCache.delete(directory)
    iconCache.delete(directory)
    sdkCache.delete(directory)
    booting.delete(directory)
    sessionLoads.delete(directory)
    sessionMeta.delete(directory)
  }

  async function loadSessions(directory: string) {
    const pending = sessionLoads.get(directory)
    if (pending) return pending

    const [store, setStore] = child(directory, { bootstrap: false })
    const meta = sessionMeta.get(directory)
    if (meta && meta.limit >= store.limit) {
      const next = trimSessions(store.session, { limit: store.limit, permission: store.permission })
      if (next.length !== store.session.length) {
        setStore("session", reconcile(next, { key: "id" }))
      }
      return
    }

    const promise = globalSDK.client.session
      .list({ directory, roots: true })
      .then((x) => {
        const nonArchived = (x.data ?? [])
          .filter((s) => !!s?.id)
          .filter((s) => !s.time?.archived)
          .sort((a, b) => cmp(a.id, b.id))

        // Read the current limit at resolve-time so callers that bump the limit while
        // a request is in-flight still get the expanded result.
        const limit = store.limit

        const children = store.session.filter((s) => !!s.parentID)
        const sessions = trimSessions([...nonArchived, ...children], { limit, permission: store.permission })

        // Store total session count (used for "load more" pagination)
        setStore("sessionTotal", nonArchived.length)
        setStore("session", reconcile(sessions, { key: "id" }))
        sessionMeta.set(directory, { limit })
      })
      .catch((err) => {
        console.error("Failed to load sessions", err)
        const project = getFilename(directory)
        showToast({ title: language.t("toast.session.listFailed.title", { project }), description: err.message })
      })

    sessionLoads.set(directory, promise)
    promise.finally(() => {
      sessionLoads.delete(directory)
    })
    return promise
  }

  async function bootstrapInstance(directory: string) {
    if (!directory) return
    const pending = booting.get(directory)
    if (pending) return pending

    const promise = (async () => {
      const [store, setStore] = ensureChild(directory)
      const cache = vcsCache.get(directory)
      if (!cache) return
      const meta = metaCache.get(directory)
      if (!meta) return
      const sdk = sdkFor(directory)

      setStore("status", "loading")

      // projectMeta is synced from persisted storage in ensureChild.
      // vcs is seeded from persisted storage in ensureChild.

      const blockingRequests = {
        project: () => sdk.project.current().then((x) => setStore("project", x.data!.id)),
        provider: () =>
          sdk.provider.list().then((x) => {
            setStore("provider", normalizeProviderList(x.data!))
          }),
        agent: () => sdk.app.agents().then((x) => setStore("agent", x.data ?? [])),
        config: () => sdk.config.get().then((x) => setStore("config", x.data!)),
      }

      try {
        await Promise.all(Object.values(blockingRequests).map((p) => retry(p)))
      } catch (err) {
        console.error("Failed to bootstrap instance", err)
        const project = getFilename(directory)
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: `Failed to reload ${project}`, description: message })
        setStore("status", "partial")
        return
      }

      if (store.status !== "complete") setStore("status", "partial")

      Promise.all([
        sdk.path.get().then((x) => setStore("path", x.data!)),
        sdk.command.list().then((x) => setStore("command", x.data ?? [])),
        sdk.session.status().then((x) => setStore("session_status", x.data!)),
        sdk.session.pingArmed().then((x) => {
          const armed: Record<string, boolean> = {}
          for (const id of x.data ?? []) armed[id] = true
          setStore("ping_armed", reconcile(armed))
        }),
        sdk.permission.autoAccepting().then((x) => {
          const accepting: Record<string, boolean> = {}
          for (const id of x.data ?? []) accepting[id] = true
          setStore("auto_accept", reconcile(accepting))
        }),
        sdk.preference.model.get().then((x) => {
          if (x.data) setStore("model_preference", reconcile(x.data))
        }),
        sdk.preference.stash.list().then((x) => {
          setStore("stash", reconcile(x.data ?? [], { key: "timestamp" }))
        }),
        loadSessions(directory),
        sdk.mcp.status().then((x) => setStore("mcp", x.data!)),
        sdk.lsp.status().then((x) => setStore("lsp", x.data!)),
        sdk.vcs.get().then((x) => {
          const next = x.data ?? store.vcs
          setStore("vcs", next)
          if (next?.branch) cache.setStore("value", next)
        }),
        sdk.permission.list().then((x) => {
          const grouped: Record<string, PermissionRequest[]> = {}
          for (const perm of x.data ?? []) {
            if (!perm?.id || !perm.sessionID) continue
            const existing = grouped[perm.sessionID]
            if (existing) {
              existing.push(perm)
              continue
            }
            grouped[perm.sessionID] = [perm]
          }

          batch(() => {
            for (const sessionID of Object.keys(store.permission)) {
              if (grouped[sessionID]) continue
              setStore("permission", sessionID, [])
            }
            for (const [sessionID, permissions] of Object.entries(grouped)) {
              setStore(
                "permission",
                sessionID,
                reconcile(
                  permissions.filter((p) => !!p?.id).sort((a, b) => cmp(a.id, b.id)),
                  { key: "id" },
                ),
              )
            }
          })
        }),
        sdk.question.list().then((x) => {
          const grouped: Record<string, QuestionRequest[]> = {}
          for (const question of x.data ?? []) {
            if (!question?.id || !question.sessionID) continue
            const existing = grouped[question.sessionID]
            if (existing) {
              existing.push(question)
              continue
            }
            grouped[question.sessionID] = [question]
          }

          batch(() => {
            for (const sessionID of Object.keys(store.question)) {
              if (grouped[sessionID]) continue
              setStore("question", sessionID, [])
            }
            for (const [sessionID, questions] of Object.entries(grouped)) {
              setStore(
                "question",
                sessionID,
                reconcile(
                  questions.filter((q) => !!q?.id).sort((a, b) => cmp(a.id, b.id)),
                  { key: "id" },
                ),
              )
            }
          })
        }),
      ]).then(() => {
        setStore("status", "complete")
      })
    })()

    booting.set(directory, promise)
    promise.finally(() => {
      booting.delete(directory)
    })
    return promise
  }

  // A session "needs attention" when the overview surfaces it: a running turn
  // (busy), finished output not yet seen (unseen), or an armed ping whose cache
  // window hasn't lapsed (pingAt is cleared server-side when it does, so a
  // present pingAt means real). This is the single definition the home overview
  // buckets on and the server keys project cleanup on — reused here so the set
  // of sessions the user juggles is exactly the set eviction protects.
  function attentionSession(entry: (typeof globalStore)["recent_hub"][number]) {
    return entry.busy || entry.unseen || entry.pingAt !== undefined
  }

  // Sessions in the attention set — and their subagent children, whose
  // transcripts the parent's task panel reads — are never evicted, so switching
  // between the sessions being juggled stays instant. recent_hub is the global
  // home overview carrying these flags.
  function liveSessions() {
    const live = new Set<string>()
    for (const entry of globalStore.recent_hub) {
      if (attentionSession(entry)) live.add(entry.sessionID)
    }
    return live
  }

  // Whether to seed a store entry for a session that was never opened here.
  // Only live sessions and subagent children of live sessions (whose transcripts
  // the parent's task panel reads) warrant one; every other unopened session is
  // a background stream we drop until it is actually opened.
  function wantsUnopenedStream(store: Store<State>, sessionID: string) {
    const live = liveSessions()
    if (live.has(sessionID)) return true
    const match = Binary.search(store.session, sessionID, (s) => s.id)
    const session = match.found ? store.session[match.index] : undefined
    return !!session?.parentID && live.has(session.parentID)
  }

  // Per-connection event scoping. The set of sessions this client
  // wants message-level events for: the open session plus the attention/live
  // sessions the user juggles (liveSessions already includes any actively-
  // working subagent, since a busy child has its own recent_hub entry). The
  // server drops every other session's streaming firehose for this connection.
  // An idle subagent streams nothing, so not listing it drops no event.
  const [openSession, rawSetOpenSession] = createSignal<string | undefined>()

  function interestSet() {
    const live = liveSessions()
    const open = openSession()
    if (open) live.add(open)
    return [...live]
  }

  // Set the open session and push interest SYNCHRONOUSLY (not via the reactive
  // effect below). subscribe-before-snapshot must hold: a deferred effect could
  // push AFTER the fetch starts, leaving a window where the server (on the
  // previous narrow set) drops the new session's live events and the snapshot
  // misses them too. Pushing here closes that window. The effect still covers
  // liveness changes.
  function setOpenSession(id: string | undefined) {
    rawSetOpenSession(id)
    return globalSDK.subscribe(interestSet())
  }

  // Guarantee a session is in our interest set on the SERVER before the caller
  // reads its snapshot, so subscribe-before-snapshot holds. sync()
  // awaits this right before loadMessages. Returns the subscribe POST promise.
  //
  // INVARIANT: sync() is the "heal the OPEN session" primitive — it is only ever
  // called for the session on screen (navigation, reconnect re-hydrate, and the
  // early tail-fetch all derive the id from the route/URL). Background sessions
  // are deliberately never sync()-ed: the store does not hold them (see the
  // eviction design, "evict idle session transcripts") and prefetch uses
  // client.session.messages directly, not sync(). So marking sessionID as the
  // open session here is correct by contract, not coincidence.
  //
  // If a future caller ever sync()s a NON-open session (a real prefetch through
  // sync, say), this line would wrongly reassign openSession and could drop the
  // viewed session's events. That caller would be the bug — route the transient
  // membership separately then, do not sync() a background session.
  function ensureInterest(sessionID: string) {
    if (openSession() !== sessionID) rawSetOpenSession(sessionID)
    return globalSDK.subscribe(interestSet())
  }

  // Re-push when liveness (recent_hub) changes while the open session is steady:
  // a background session going busy joins the interest set, an idle one leaves.
  createEffect(() => {
    globalSDK.subscribe(interestSet())
  })

  // Evict a session's cached transcript unless it is live, a child of a live
  // session, or explicitly kept (the currently-viewed session). Bodies drop from
  // the store; a reopen re-fetches tail-first, cheap against the local server.
  function evictSession(store: Store<State>, setStore: SetStoreFunction<State>, sessionID: string, keep: Set<string>) {
    if (keep.has(sessionID)) return
    const live = liveSessions()
    if (live.has(sessionID)) return
    const session = (() => {
      const match = Binary.search(store.session, sessionID, (s) => s.id)
      return match.found ? store.session[match.index] : undefined
    })()
    if (session?.parentID && live.has(session.parentID)) return
    purgeSessionData(store, setStore, sessionID)
  }

  function purgeMessageParts(setStore: SetStoreFunction<State>, messageID: string | undefined) {
    if (!messageID) return
    setStore(
      produce((draft) => {
        delete draft.part[messageID]
      }),
    )
  }

  function purgeSessionData(store: Store<State>, setStore: SetStoreFunction<State>, sessionID: string | undefined) {
    if (!sessionID) return

    const messages = store.message[sessionID]
    const messageIDs = (messages ?? []).map((m) => m.id).filter((id): id is string => !!id)

    setStore(
      produce((draft) => {
        delete draft.message[sessionID]
        delete draft.session_diff[sessionID]
        delete draft.todo[sessionID]
        delete draft.permission[sessionID]
        delete draft.question[sessionID]
        delete draft.session_status[sessionID]
        delete draft.ping_armed[sessionID]
        delete draft.auto_accept[sessionID]

        for (const messageID of messageIDs) {
          delete draft.part[messageID]
        }
      }),
    )
  }

  const unsub = globalSDK.event.listen((e) => {
    const directory = e.name
    const event = e.details

    if (directory === "global") {
      switch (event?.type) {
        case "server.connected": {
          // Every (re)attach of the event stream: re-bootstrap the world so a
          // reconnected client redraws current state instead of showing the
          // stale snapshot it had when the stream dropped (tmux reattach).
          refresh()
          // Wake open sessions so they re-fetch messages/parts the server
          // published while the stream was down (no replay). Harmless on the
          // first connect: the force path no-ops until the session is hydrated.
          setReconnect((n) => n + 1)
          return
        }
        case "global.disposed": {
          refresh()
          return
        }
        case "project.updated": {
          const result = Binary.search(globalStore.project, event.properties.id, (s) => s.id)
          if (result.found) {
            setGlobalStore("project", result.index, reconcile(event.properties))
            return
          }
          setGlobalStore(
            "project",
            produce((draft) => {
              draft.splice(result.index, 0, event.properties)
            }),
          )
          break
        }
        case "model.preference.updated": {
          setGlobalStore("model_preference", reconcile(event.properties))
          for (const [, set] of Object.values(children)) set("model_preference", reconcile(event.properties))
          return
        }
        case "stash.updated": {
          setGlobalStore("stash", reconcile(event.properties.entries, { key: "timestamp" }))
          for (const [, set] of Object.values(children))
            set("stash", reconcile(event.properties.entries, { key: "timestamp" }))
          return
        }
        case "recent.updated": {
          setGlobalStore("recent_hub", reconcile(event.properties.entries, { key: "sessionID" }))
          return
        }
        case "open-projects.updated": {
          setGlobalStore("open_projects", reconcile(event.properties.entries, { key: "id" }))
          return
        }
      }
      return
    }

    const existing = children[directory]
    if (!existing) return

    const [store, setStore] = existing

    const cleanupSessionCaches = (sessionID: string) => {
      if (!sessionID) return

      const hasAny =
        store.message[sessionID] !== undefined ||
        store.session_diff[sessionID] !== undefined ||
        store.todo[sessionID] !== undefined ||
        store.permission[sessionID] !== undefined ||
        store.question[sessionID] !== undefined ||
        store.session_status[sessionID] !== undefined

      if (!hasAny) return

      setStore(
        produce((draft) => {
          const messages = draft.message[sessionID]
          if (messages) {
            for (const message of messages) {
              const id = message?.id
              if (!id) continue
              delete draft.part[id]
            }
          }

          delete draft.message[sessionID]
          delete draft.session_diff[sessionID]
          delete draft.todo[sessionID]
          delete draft.permission[sessionID]
          delete draft.question[sessionID]
          delete draft.session_status[sessionID]
          delete draft.ping_armed[sessionID]
          delete draft.auto_accept[sessionID]
        }),
      )
    }

    switch (event.type) {
      case "server.instance.disposed": {
        push(directory)
        return
      }
      case "session.created": {
        const info = event.properties.info
        const result = Binary.search(store.session, info.id, (s) => s.id)
        if (result.found) {
          setStore("session", result.index, reconcile(info))
          break
        }
        const next = store.session.slice()
        next.splice(result.index, 0, info)
        const trimmed = trimSessions(next, { limit: store.limit, permission: store.permission })
        setStore("session", reconcile(trimmed, { key: "id" }))
        if (!info.parentID) {
          setStore("sessionTotal", (value) => value + 1)
        }
        break
      }
      case "session.updated": {
        const info = event.properties.info
        const result = Binary.search(store.session, info.id, (s) => s.id)
        if (info.time.archived) {
          if (result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          cleanupSessionCaches(info.id)
          if (info.parentID) break
          setStore("sessionTotal", (value) => Math.max(0, value - 1))
          break
        }
        if (result.found) {
          setStore("session", result.index, reconcile(info))
          break
        }
        const next = store.session.slice()
        next.splice(result.index, 0, info)
        const trimmed = trimSessions(next, { limit: store.limit, permission: store.permission })
        setStore("session", reconcile(trimmed, { key: "id" }))
        break
      }
      case "session.deleted": {
        const sessionID = event.properties.info.id
        const result = Binary.search(store.session, sessionID, (s) => s.id)
        if (result.found) {
          setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 1)
            }),
          )
        }
        cleanupSessionCaches(sessionID)
        if (event.properties.info.parentID) break
        setStore("sessionTotal", (value) => Math.max(0, value - 1))
        break
      }
      case "session.diff":
        // keep the store bodyless (summary tier); bodies are lazy-fetched per file
        setStore(
          "session_diff",
          event.properties.sessionID,
          reconcile(
            event.properties.diff.map(({ before, after, ...rest }) => rest),
            { key: "file" },
          ),
        )
        break
      case "todo.updated":
        setStore("todo", event.properties.sessionID, reconcile(event.properties.todos, { key: "id" }))
        break
      case "session.status": {
        setStore("session_status", event.properties.sessionID, reconcile(event.properties.status))
        break
      }
      case "session.ping.armed": {
        setStore("ping_armed", event.properties.sessionID, event.properties.armed)
        break
      }
      case "permission.autoaccept": {
        setStore("auto_accept", event.properties.sessionID, event.properties.enabled)
        break
      }
      case "message.updated": {
        const sessionID = event.properties.info.sessionID
        const messages = store.message[sessionID]
        if (!messages) {
          // No cached transcript means this session was never opened here. Only
          // seed one for a session whose updates the UI actively needs — a live
          // session or a subagent child of one (its parent's task panel reads
          // it). Otherwise a background firehose (another session streaming in a
          // shared directory) would grow the store unbounded; drop it and let a
          // real open fetch it fresh.
          if (!wantsUnopenedStream(store, sessionID)) break
          setStore("message", sessionID, [event.properties.info])
          break
        }
        const result = Binary.search(messages, event.properties.info.id, (m) => m.id)
        if (result.found) {
          setStore("message", event.properties.info.sessionID, result.index, reconcile(event.properties.info))
          break
        }
        setStore(
          "message",
          event.properties.info.sessionID,
          produce((draft) => {
            draft.splice(result.index, 0, event.properties.info)
          }),
        )
        break
      }
      case "message.removed": {
        const sessionID = event.properties.sessionID
        const messageID = event.properties.messageID

        setStore(
          produce((draft) => {
            const messages = draft.message[sessionID]
            if (messages) {
              const result = Binary.search(messages, messageID, (m) => m.id)
              if (result.found) {
                messages.splice(result.index, 1)
              }
            }

            delete draft.part[messageID]
          }),
        )
        break
      }
      case "message.part.updated": {
        const part = event.properties.part
        const delta = event.properties.delta
        // Deltas only ride on text/reasoning parts (the only parts with a text
        // field the server blanks to keep the wire O(n) instead of O(n^2)).
        const isText = part.type === "text" || part.type === "reasoning"
        const textDelta = delta !== undefined && isText ? delta : undefined
        const parts = store.part[part.messageID]
        if (!parts) {
          // Same guard as message.updated: a part for a message we don't hold is
          // an unopened session's stream. Seed it only when the session is live
          // or a live session's child; otherwise drop it (a real open refetches).
          if (store.message[part.sessionID] === undefined && !wantsUnopenedStream(store, part.sessionID)) break
          // With no prior part to append to, the delta IS the text so far.
          const seed =
            textDelta !== undefined && (part.type === "text" || part.type === "reasoning")
              ? { ...part, text: textDelta }
              : part
          setStore("part", part.messageID, [seed])
          break
        }
        const result = Binary.search(parts, part.id, (p) => p.id)
        if (result.found) {
          // Delta path: server sent an empty text + the increment. Append it to
          // the text we already hold instead of overwriting with the blank.
          if (textDelta !== undefined) {
            setStore(
              "part",
              part.messageID,
              result.index,
              produce((p) => {
                if (p.type === "text" || p.type === "reasoning") p.text = p.text + textDelta
              }),
            )
            break
          }
          setStore("part", part.messageID, result.index, reconcile(part, { merge: true }))
          break
        }
        // First chunk of a new part on a message that already holds parts: the
        // server blanked text, so the delta is the text so far. Insert with it,
        // else the first chunk is lost and streaming starts one delta short.
        const inserted =
          textDelta !== undefined && (part.type === "text" || part.type === "reasoning")
            ? { ...part, text: textDelta }
            : part
        setStore(
          "part",
          part.messageID,
          produce((draft) => {
            draft.splice(result.index, 0, inserted)
          }),
        )
        break
      }
      case "message.part.removed": {
        const messageID = event.properties.messageID
        const parts = store.part[messageID]
        if (!parts) break
        const result = Binary.search(parts, event.properties.partID, (p) => p.id)
        if (result.found) {
          setStore(
            produce((draft) => {
              const list = draft.part[messageID]
              if (!list) return
              const next = Binary.search(list, event.properties.partID, (p) => p.id)
              if (!next.found) return
              list.splice(next.index, 1)
              if (list.length === 0) delete draft.part[messageID]
            }),
          )
        }
        break
      }
      case "vcs.branch.updated": {
        const next = { branch: event.properties.branch }
        setStore("vcs", next)
        const cache = vcsCache.get(directory)
        if (cache) cache.setStore("value", next)
        break
      }
      case "permission.asked": {
        const sessionID = event.properties.sessionID
        const permissions = store.permission[sessionID]
        if (!permissions) {
          setStore("permission", sessionID, [event.properties])
          break
        }

        const result = Binary.search(permissions, event.properties.id, (p) => p.id)
        if (result.found) {
          setStore("permission", sessionID, result.index, reconcile(event.properties))
          break
        }

        setStore(
          "permission",
          sessionID,
          produce((draft) => {
            draft.splice(result.index, 0, event.properties)
          }),
        )
        break
      }
      case "permission.replied": {
        const permissions = store.permission[event.properties.sessionID]
        if (!permissions) break
        const result = Binary.search(permissions, event.properties.requestID, (p) => p.id)
        if (!result.found) break
        setStore(
          "permission",
          event.properties.sessionID,
          produce((draft) => {
            draft.splice(result.index, 1)
          }),
        )
        break
      }
      case "question.asked": {
        const sessionID = event.properties.sessionID
        const questions = store.question[sessionID]
        if (!questions) {
          setStore("question", sessionID, [event.properties])
          break
        }

        const result = Binary.search(questions, event.properties.id, (q) => q.id)
        if (result.found) {
          setStore("question", sessionID, result.index, reconcile(event.properties))
          break
        }

        setStore(
          "question",
          sessionID,
          produce((draft) => {
            draft.splice(result.index, 0, event.properties)
          }),
        )
        break
      }
      case "question.replied":
      case "question.rejected": {
        const questions = store.question[event.properties.sessionID]
        if (!questions) break
        const result = Binary.search(questions, event.properties.requestID, (q) => q.id)
        if (!result.found) break
        setStore(
          "question",
          event.properties.sessionID,
          produce((draft) => {
            draft.splice(result.index, 1)
          }),
        )
        break
      }
      case "lsp.updated": {
        sdkFor(directory)
          .lsp.status()
          .then((x) => setStore("lsp", x.data ?? []))
        break
      }
    }
  })
  onCleanup(unsub)
  onCleanup(() => {
    if (!timer) return
    clearTimeout(timer)
  })

  // Pull the instance-wide recent session list. Server-owned so every client
  // renders the same overview; refreshed on bootstrap, reconnect, and session
  // membership changes.
  async function refreshRecent() {
    const recent = await globalSDK.client.global
      .recent()
      .then((x) => x.data)
      .catch(() => undefined)
    if (!recent) return
    setGlobalStore("recent_hub", reconcile(recent, { key: "sessionID" }))
  }

  async function bootstrap() {
    const health = await globalSDK.client.global
      .health()
      .then((x) => x.data)
      .catch(() => undefined)
    if (!health?.healthy) {
      showToast({
        variant: "error",
        title: language.t("dialog.server.add.error"),
        description: language.t("error.globalSync.connectFailed", { url: globalSDK.url }),
      })
      setGlobalStore("ready", true)
      return
    }

    const tasks = [
      retry(() =>
        globalSDK.client.path.get().then((x) => {
          setGlobalStore("path", x.data!)
        }),
      ),
      retry(() =>
        globalSDK.client.global.config.get().then((x) => {
          setGlobalStore("config", x.data!)
        }),
      ),
      retry(() =>
        globalSDK.client.project.list().then(async (x) => {
          const projects = (x.data ?? [])
            .filter((p) => !!p?.id)
            .filter((p) => !!p.worktree && !p.worktree.includes("opencode-test"))
            .slice()
            .sort((a, b) => cmp(a.id, b.id))
          setGlobalStore("project", projects)
        }),
      ),
      retry(() =>
        globalSDK.client.provider.list().then((x) => {
          setGlobalStore("provider", normalizeProviderList(x.data!))
        }),
      ),
      retry(() =>
        globalSDK.client.provider.auth().then((x) => {
          setGlobalStore("provider_auth", x.data ?? {})
        }),
      ),
      retry(() => refreshRecent()),
      retry(() =>
        globalSDK.client.global.projects.open().then((x) => {
          setGlobalStore("open_projects", x.data ?? [])
        }),
      ),
      retry(() =>
        globalSDK.client.preference.model.get().then((x) => {
          if (x.data) setGlobalStore("model_preference", x.data)
        }),
      ),
      retry(() =>
        globalSDK.client.preference.stash.list().then((x) => {
          setGlobalStore("stash", x.data ?? [])
        }),
      ),
    ]

    const results = await Promise.allSettled(tasks)
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason)

    if (errors.length) {
      const message = errors[0] instanceof Error ? errors[0].message : String(errors[0])
      const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : ""
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: message + more,
      })
    }

    setGlobalStore("ready", true)
  }

  onMount(() => {
    bootstrap()
  })

  function projectMeta(directory: string, patch: ProjectMeta) {
    const [store, setStore] = ensureChild(directory)
    const cached = metaCache.get(directory)
    if (!cached) return
    const previous = store.projectMeta ?? {}
    const icon = patch.icon ? { ...(previous.icon ?? {}), ...patch.icon } : previous.icon
    const commands = patch.commands ? { ...(previous.commands ?? {}), ...patch.commands } : previous.commands
    const next = {
      ...previous,
      ...patch,
      icon,
      commands,
    }
    cached.setStore("value", next)
    setStore("projectMeta", next)
  }

  function projectIcon(directory: string, value: string | undefined) {
    const [store, setStore] = ensureChild(directory)
    const cached = iconCache.get(directory)
    if (!cached) return
    if (store.icon === value) return
    cached.setStore("value", value)
    setStore("icon", value)
  }

  return {
    data: globalStore,
    set: setGlobalStore,
    get ready() {
      return globalStore.ready
    },
    get error() {
      return globalStore.error
    },
    reconnect,
    child,
    disposeChild,
    evictSession,
    attentionSession,
    setOpenSession,
    ensureInterest,
    bootstrap,
    updateConfig: (config: Config) => {
      setGlobalStore("reload", "pending")
      return globalSDK.client.global.config.update({ config }).finally(() => {
        setTimeout(() => {
          setGlobalStore("reload", "complete")
        }, 1000)
      })
    },
    project: {
      loadSessions,
      meta: projectMeta,
      icon: projectIcon,
      open: (directory: string) => globalSDK.client.global.projects.openAdd({ directory }),
      close: (directory: string, force?: boolean) => globalSDK.client.global.projects.close({ directory, force }),
    },
  }
}

const GlobalSyncContext = createContext<ReturnType<typeof createGlobalSync>>()

export function GlobalSyncProvider(props: ParentProps) {
  const value = createGlobalSync()
  return (
    <Switch>
      <Match when={value.ready}>
        <GlobalSyncContext.Provider value={value}>{props.children}</GlobalSyncContext.Provider>
      </Match>
    </Switch>
  )
}

export function useGlobalSync() {
  const context = useContext(GlobalSyncContext)
  if (!context) throw new Error("useGlobalSync must be used within GlobalSyncProvider")
  return context
}
