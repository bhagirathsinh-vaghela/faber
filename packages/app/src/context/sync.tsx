import { batch, createMemo } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { Binary } from "@opencode-ai/util/binary"
import { retry } from "@opencode-ai/util/retry"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useGlobalSync } from "./global-sync"
import { useSDK } from "./sdk"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"

const keyFor = (directory: string, id: string) => `${directory}\n${id}`

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const globalSync = useGlobalSync()
    const sdk = useSDK()

    type Child = ReturnType<(typeof globalSync)["child"]>
    type Setter = Child[1]

    const current = createMemo(() => globalSync.child(sdk.directory))
    const absolute = (path: string) => (current()[0].path.directory + "/" + path).replace("//", "/")
    const chunk = 400
    // tail-first bootstrap: paint the newest N messages immediately so the
    // session is interactive, then backfill the rest to the compaction
    // boundary in the background
    const tail = 40
    const inflight = new Map<string, Promise<void>>()
    const inflightDiff = new Map<string, Promise<void>>()
    const inflightTodo = new Map<string, Promise<void>>()
    const [meta, setMeta] = createStore({
      limit: {} as Record<string, number>,
      complete: {} as Record<string, boolean>,
      loading: {} as Record<string, boolean>,
    })

    const getSession = (sessionID: string) => {
      const store = current()[0]
      const match = Binary.search(store.session, sessionID, (s) => s.id)
      if (match.found) return store.session[match.index]
      return undefined
    }

    const limitFor = (count: number) => {
      if (count <= chunk) return chunk
      return Math.ceil(count / chunk) * chunk
    }

    const loadMessages = async (input: {
      directory: string
      client: typeof sdk.client
      setStore: Setter
      sessionID: string
      limit: number
      compacted?: boolean
    }) => {
      const key = keyFor(input.directory, input.sessionID)
      if (meta.loading[key]) return

      // default fetch stops at the compaction boundary; load-more passes
      // compacted:false to page into pre-compaction history
      const compacted = input.compacted ?? true

      setMeta("loading", key, true)
      await retry(() =>
        input.client.session.messages({
          sessionID: input.sessionID,
          limit: input.limit,
          ...(compacted ? {} : { compacted: "false" }),
        }),
      )
        .then((messages) => {
          const items = (messages.data ?? []).filter((x) => !!x?.info?.id)
          const next = items
            .map((x) => x.info)
            .filter((m) => !!m?.id)
            .sort((a, b) => cmp(a.id, b.id))

          // a completed compaction boundary means older history exists behind it
          const bounded =
            compacted && items.some((m) => m.info.role === "user" && m.parts.some((p) => p.type === "compaction"))

          batch(() => {
            input.setStore("message", input.sessionID, reconcile(next, { key: "id" }))

            for (const message of items) {
              input.setStore(
                "part",
                message.info.id,
                reconcile(
                  message.parts.filter((p) => !!p?.id).sort((a, b) => cmp(a.id, b.id)),
                  { key: "id" },
                ),
              )
            }

            setMeta("limit", key, input.limit)
            // keep load-more available when we stopped at a boundary
            setMeta("complete", key, !bounded && next.length < input.limit)
          })
        })
        .finally(() => {
          setMeta("loading", key, false)
        })
    }

    return {
      get data() {
        return current()[0]
      },
      get set(): Setter {
        return current()[1]
      },
      get status() {
        return current()[0].status
      },
      get ready() {
        return current()[0].status !== "loading"
      },
      get project() {
        const store = current()[0]
        const match = Binary.search(globalSync.data.project, store.project, (p) => p.id)
        if (match.found) return globalSync.data.project[match.index]
        return undefined
      },
      session: {
        get: getSession,
        // Server truth for "is this session open/alive" = busy OR a scheduled
        // ping (pingAt set) — the same signal the overview's attention bucket
        // uses. pingAt is cleared server-side when the cache window lapses, so an
        // armed-but-cold daemon does not read as live. A reconnecting client
        // defers to this: a session force-stopped while the client was offline
        // reads not-live, so it navigates home instead of resurrecting. Explicit
        // reopen is a fresh open, not this reconnect path, so it is unaffected.
        async live(sessionID: string) {
          // Refresh the hub so the decision uses current server state, not a
          // snapshot from before the disconnect.
          const recent = await sdk.client.global
            .recent()
            .then((x) => x.data ?? [])
            .catch(() => globalSync.data.recent_hub)
          return recent.some((entry) => entry.sessionID === sessionID && (entry.busy || entry.pingAt !== undefined))
        },
        addOptimisticMessage(input: {
          sessionID: string
          messageID: string
          parts: Part[]
          agent: string
          model: { providerID: string; modelID: string }
        }) {
          const message: Message = {
            id: input.messageID,
            sessionID: input.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: input.agent,
            model: input.model,
          }
          current()[1](
            produce((draft) => {
              const messages = draft.message[input.sessionID]
              if (!messages) {
                draft.message[input.sessionID] = [message]
              } else {
                const result = Binary.search(messages, input.messageID, (m) => m.id)
                messages.splice(result.index, 0, message)
              }
              draft.part[input.messageID] = input.parts.filter((p) => !!p?.id).sort((a, b) => cmp(a.id, b.id))
            }),
          )
        },
        // Heal the OPEN session's transcript. CONTRACT: only call this for the
        // session currently on screen — it marks sessionID as the open session
        // for event scoping (see ensureInterest below). Background/prefetch loads
        // must use client.session.messages directly, never sync().
        async sync(sessionID: string, force = false) {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          const key = keyFor(directory, sessionID)
          const hasSession = (() => {
            const match = Binary.search(store.session, sessionID, (s) => s.id)
            return match.found
          })()

          const hasMessages = store.message[sessionID] !== undefined
          const hydrated = meta.limit[key] !== undefined

          // Re-arm the cache-ping daemon on every open. GET /session/:id is the
          // server's arm-on-attach hook (idempotent, self-stops if the cache
          // window is dead). It fires here UNCONDITIONALLY — before the cached
          // early-return below and independent of the data-load path, which
          // skips the fetch when the session is already in the store. Without
          // this, reopening an already-loaded recent session never re-armed.
          void client.session.get({ sessionID }).catch(() => {})

          // Subscribe-before-snapshot: make sure the server has
          // this session in our event-interest set BEFORE we read its snapshot,
          // so any event fired after the snapshot arrives live and reconciles by
          // id instead of being dropped. Awaited here (not in the caller) so the
          // ordering holds no matter which path triggered the sync. Fail-open on
          // the server means a slow/failed subscribe over-sends, never drops.
          await globalSync.ensureInterest(sessionID)

          // force re-fetch re-hydrates messages+parts at the loaded limit after
          // a reconnect: the server has no SSE replay, so a message (or a part
          // completed) during the disconnect window is missing from the store
          // and reconcile heals it. Skip only the early-return; keep the same
          // load path so the reconcile-by-id below dedupes.
          if (force && hydrated) {
            return loadMessages({ directory, client, setStore, sessionID, limit: meta.limit[key]! })
          }

          if (hasSession && hasMessages && hydrated) return
          const pending = inflight.get(key)
          if (pending) return pending

          const count = store.message[sessionID]?.length ?? 0
          const full = hydrated ? (meta.limit[key] ?? chunk) : limitFor(count)
          // fresh bootstrap paints the tail first; a hydrated/resume load keeps
          // whatever was already loaded
          const initial = hydrated ? full : Math.min(tail, full)

          const sessionReq = hasSession
            ? Promise.resolve()
            : retry(() => client.session.get({ sessionID })).then((session) => {
                const data = session.data
                if (!data) return
                setStore(
                  "session",
                  produce((draft) => {
                    const match = Binary.search(draft, sessionID, (s) => s.id)
                    if (match.found) {
                      draft[match.index] = data
                      return
                    }
                    draft.splice(match.index, 0, data)
                  }),
                )
              })

          const messagesReq =
            hasMessages && hydrated
              ? Promise.resolve()
              : loadMessages({
                  directory,
                  client,
                  setStore,
                  sessionID,
                  limit: initial,
                })

          const promise = Promise.all([sessionReq, messagesReq])
            .then(() => {})
            .finally(() => {
              inflight.delete(key)
            })

          // background backfill: once the tail has painted, load the rest up to
          // the compaction boundary without blocking interaction
          if (!hydrated && initial < full) {
            promise.then(() => {
              if (meta.complete[key]) return
              void loadMessages({ directory, client, setStore, sessionID, limit: full })
            })
          }

          inflight.set(key, promise)
          return promise
        },
        async diff(sessionID: string) {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          if (store.session_diff[sessionID] !== undefined) return

          const key = keyFor(directory, sessionID)
          const pending = inflightDiff.get(key)
          if (pending) return pending

          const promise = retry(() => client.session.diff({ sessionID, summary: true }))
            .then((diff) => {
              setStore("session_diff", sessionID, reconcile(diff.data ?? [], { key: "file" }))
            })
            .finally(() => {
              inflightDiff.delete(key)
            })

          inflightDiff.set(key, promise)
          return promise
        },
        async diffFile(sessionID: string, file: string) {
          const client = sdk.client
          const [store, setStore] = globalSync.child(sdk.directory)
          const current = store.session_diff[sessionID]?.find((d) => d.file === file)
          if (current && typeof current.before === "string" && typeof current.after === "string") return

          const diff = await retry(() => client.session.diff({ sessionID, file }))
          const body = diff.data?.[0]
          if (!body) return
          setStore("session_diff", sessionID, (list) =>
            (list ?? []).map((d) => (d.file === file ? { ...d, before: body.before, after: body.after } : d)),
          )
        },
        async todo(sessionID: string) {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          if (store.todo[sessionID] !== undefined) return

          const key = keyFor(directory, sessionID)
          const pending = inflightTodo.get(key)
          if (pending) return pending

          const promise = retry(() => client.session.todo({ sessionID }))
            .then((todo) => {
              setStore("todo", sessionID, reconcile(todo.data ?? [], { key: "id" }))
            })
            .finally(() => {
              inflightTodo.delete(key)
            })

          inflightTodo.set(key, promise)
          return promise
        },
        history: {
          more(sessionID: string) {
            const store = current()[0]
            const key = keyFor(sdk.directory, sessionID)
            if (store.message[sessionID] === undefined) return false
            if (meta.limit[key] === undefined) return false
            if (meta.complete[key]) return false
            return true
          },
          loading(sessionID: string) {
            const key = keyFor(sdk.directory, sessionID)
            return meta.loading[key] ?? false
          },
          async loadMore(sessionID: string, count = chunk) {
            const directory = sdk.directory
            const client = sdk.client
            const [, setStore] = globalSync.child(directory)
            const key = keyFor(directory, sessionID)
            if (meta.loading[key]) return
            if (meta.complete[key]) return

            const currentLimit = meta.limit[key] ?? chunk
            await loadMessages({
              directory,
              client,
              setStore,
              sessionID,
              limit: currentLimit + count,
              compacted: false,
            })
          },
        },
        fetch: async (count = 10) => {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          setStore("limit", (x) => x + count)
          await client.session.list().then((x) => {
            const sessions = (x.data ?? [])
              .filter((s) => !!s?.id)
              .sort((a, b) => cmp(a.id, b.id))
              .slice(0, store.limit)
            setStore("session", reconcile(sessions, { key: "id" }))
          })
        },
        more: createMemo(() => current()[0].session.length >= current()[0].limit),
        // Drop a session's cached transcript when navigating away from it, so
        // idle scrollback stops accumulating in memory. globalSync.evictSession
        // keeps live sessions (and live sessions' children) so the sessions
        // being juggled stay instant; `keep` protects the session just opened.
        evict(sessionID: string, keep?: string) {
          const [store, setStore] = globalSync.child(sdk.directory)
          globalSync.evictSession(store, setStore, sessionID, new Set(keep ? [keep] : []))
          // If the transcript was actually dropped, clear its load meta so a
          // reopen re-hydrates tail-first instead of short-circuiting as loaded.
          if (store.message[sessionID] === undefined) {
            const key = keyFor(sdk.directory, sessionID)
            setMeta(
              produce((draft) => {
                delete draft.limit[key]
                delete draft.complete[key]
                delete draft.loading[key]
              }),
            )
          }
        },
        archive: async (sessionID: string) => {
          const directory = sdk.directory
          const client = sdk.client
          const [, setStore] = globalSync.child(directory)
          await client.session.update({ sessionID, time: { archived: Date.now() } })
          setStore(
            produce((draft) => {
              const match = Binary.search(draft.session, sessionID, (s) => s.id)
              if (match.found) draft.session.splice(match.index, 1)
            }),
          )
        },
      },
      absolute,
      reconnect: globalSync.reconnect,
      setOpenSession: globalSync.setOpenSession,
      get directory() {
        return current()[0].path.directory
      },
    }
  },
})
