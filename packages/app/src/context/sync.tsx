import { batch, createMemo } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { Binary } from "@opencode-ai/util/binary"
import { Identifier } from "@opencode-ai/util/identifier"
import { retry } from "@opencode-ai/util/retry"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useGlobalSync } from "./global-sync"
import { useSDK } from "./sdk"
import { Snapshot } from "@/utils/snapshot"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"

const keyFor = (directory: string, id: string) => `${directory}\n${id}`

const cmp = Identifier.compare

// Level 2 streaming does not persist a text/reasoning part until block-end
// (or a 256KB checkpoint), so a mid-turn REST snapshot is behind the stream.
// Mirror the SSE handler's longer-text-wins rule for these two part types.
export function guardParts(snapshot: Part[], held: Part[] | undefined, completed: boolean): Part[] {
  if (completed || !held?.length) return snapshot
  const snapshotByID = new Map(snapshot.map((p) => [p.id, p]))
  const guarded = new Map(snapshotByID)
  for (const hp of held) {
    if (hp.type !== "text" && hp.type !== "reasoning") continue
    const sp = snapshotByID.get(hp.id)
    if (!sp) {
      guarded.set(hp.id, hp)
      continue
    }
    if ((sp.type === "text" || sp.type === "reasoning") && (hp as { text: string }).text.length > (sp as { text: string }).text.length)
      guarded.set(hp.id, hp)
  }
  return [...guarded.values()].sort((a, b) => cmp(a.id, b.id))
}

export const {
  use: useSync,
  useOptional: useSyncOptional,
  provider: SyncProvider,
} = createSimpleContext({
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
    // In-flight GET /session/:id, so the two effects that both open a session
    // (the route-change sync and the first-connect reconnect sync, which race on
    // a fresh open) share ONE record fetch instead of each issuing its own.
    const inflightSession = new Map<string, Promise<void>>()
    // Sessions whose reconnect heal landed while a load was already running, so
    // it has to be re-run once that load settles.
    const pendingHeal = new Set<string>()
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

    // One GET /session/:id per open, doing BOTH jobs the open needs from it:
    // it is the server's arm-on-attach hook for the cache-ping daemon
    // (idempotent, self-stops if the window is dead), AND its result fills the
    // store when the record is missing. `getSession` returning undefined means
    // "not cached", never "does not exist", so a load path that can leave the
    // record out (a message-only heal, an eviction that kept the transcript)
    // resolves the miss through this rather than reading it as absent. Coalesced
    // into the single fetch the open already made, so a cold open costs one
    // record round-trip, not two (the record is 2.5KB, so this matters on
    // cellular). Errors are swallowed: arming is best-effort and a failed fill
    // just leaves the miss to the next open.
    const armAndFillSession = (directory: string, client: typeof sdk.client, setStore: Setter, sessionID: string) => {
      const key = keyFor(directory, sessionID)
      const existing = inflightSession.get(key)
      if (existing) return existing
      // Single-flight: store the promise, delete on settle (in finally, so a
      // caller arriving just after this resolves starts a fresh fetch rather
      // than joining a dead one). Errors are swallowed: arming is best-effort
      // and a failed fill just leaves the miss to the next open.
      const promise = retry(() => client.session.get({ sessionID }))
        .then((session) => {
          const record = session.data
          if (!record) return
          // bootstrap:false — a pure read of current store state, never a
          // trigger for the per-directory fan-out (the child already exists by
          // the time a fetch settles).
          const store = globalSync.child(directory, { bootstrap: false })[0]
          if (Binary.search(store.session, sessionID, (s) => s.id).found) return
          setStore(
            "session",
            produce((draft) => {
              const match = Binary.search(draft, sessionID, (s) => s.id)
              if (match.found) draft[match.index] = record
              else draft.splice(match.index, 0, record)
            }),
          )
        })
        .catch(() => {})
        .finally(() => inflightSession.delete(key))
      inflightSession.set(key, promise)
      return promise
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
              const held = current()[0].part[message.info.id]
              const snapshotParts = message.parts.filter((p) => !!p?.id).sort((a, b) => cmp(a.id, b.id))
              const merged = guardParts(snapshotParts, held, !!("completed" in message.info.time && message.info.time.completed))
              input.setStore("part", message.info.id, reconcile(merged, { key: "id" }))
            }

            setMeta("limit", key, input.limit)
            // keep load-more available when we stopped at a boundary
            setMeta("complete", key, !bounded && next.length < input.limit)
          })
        })
        .finally(() => {
          setMeta("loading", key, false)
          drainHeal(input)
        })
    }

    // Re-run a heal that had to stand aside for an in-flight load. Deferred to a
    // task so the loading flag it tests has actually been released.
    const drainHeal = (input: {
      directory: string
      client: typeof sdk.client
      setStore: Setter
      sessionID: string
      limit: number
    }) => {
      const key = keyFor(input.directory, input.sessionID)
      if (!pendingHeal.delete(key)) return
      setTimeout(() => {
        // The session can be evicted between queueing and firing, and healing a
        // transcript the store no longer holds would refetch it behind the
        // user's back.
        const [store] = globalSync.child(input.directory, { bootstrap: false })
        if (store.message[input.sessionID] === undefined) return
        void deltaMessages({ ...input, limit: meta.limit[key] ?? input.limit })
      }, 0)
    }

    // Reconnect delta: heal the open session's transcript after a
    // disconnect by fetching only the messages the gap could have added, instead
    // of re-downloading the whole loaded window. The cursor is the SECOND-newest
    // known message id, so the server (strict id > after) returns the newest
    // known message too: that message may have streamed parts or completed while
    // we were offline, and re-fetching it lets the reconcile-by-id below merge
    // those in. With fewer than two known messages there is no meaningful delta
    // boundary, so fall back to the full hydrating load.
    const deltaMessages = async (input: {
      directory: string
      client: typeof sdk.client
      setStore: Setter
      sessionID: string
      limit: number
    }) => {
      const key = keyFor(input.directory, input.sessionID)
      // A heal that arrives mid-load must not be dropped. The in-flight request
      // was issued before the gap existed, so its answer cannot contain what the
      // gap added, and nothing else would come back for it: this is the one
      // caller whose skip leaves the transcript permanently short.
      if (meta.loading[key]) {
        pendingHeal.add(key)
        return
      }
      const known = current()[0].message[input.sessionID]
      if (!known || known.length < 2) return loadMessages(input)
      const cursor = known[known.length - 2].id

      setMeta("loading", key, true)
      await retry(() => input.client.session.messages({ sessionID: input.sessionID, after: cursor }))
        .then((messages) => {
          const items = (messages.data ?? []).filter((x) => !!x?.info?.id)
          if (items.length === 0) return
          const store = current()[0]
          const inserts: typeof items = []
          batch(() => {
            for (const item of items) {
              const msgs = store.message[input.sessionID] ?? []
              const match = Binary.search(msgs, item.info.id, (m) => m.id)
              if (match.found) {
                input.setStore("message", input.sessionID, match.index, reconcile(item.info, { merge: true }))
              } else {
                inserts.push(item)
              }
            }
            if (inserts.length) {
              input.setStore(
                "message",
                input.sessionID,
                produce((list) => {
                  for (const item of inserts) {
                    const match = Binary.search(list, item.info.id, (m) => m.id)
                    list.splice(match.index, 0, item.info)
                  }
                }),
              )
            }
            for (const item of items) {
              const held = store.part[item.info.id]
              const snapshotParts = item.parts.filter((p) => !!p?.id).sort((a, b) => cmp(a.id, b.id))
              const merged = guardParts(snapshotParts, held, !!("completed" in item.info.time && item.info.time.completed))
              input.setStore("part", item.info.id, reconcile(merged, { key: "id" }))
            }
          })
        })
        .finally(() => {
          setMeta("loading", key, false)
          drainHeal(input)
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
        // Whether a reconnecting client may stay on this session. The question is
        // NOT "is it working" — an idle session is the normal case and the user
        // is sitting on it. It is "does this session still exist somewhere the
        // client can render it", which is false only when the session was deleted
        // or its project closed from another client.
        //
        // Deliberately not busy/pingAt/keepWarm: all three are liveness, and all
        // three read false for an ordinary idle session, so any of them as the
        // test bounces the user home on every server restart.
        async reachable(sessionID: string) {
          const openBeforeAttaching = await sdk.client.global.projects
            .open()
            .then((x) => (x.data ?? []).some((project) => project.worktree === sdk.directory))
            .catch(() => undefined)
          if (openBeforeAttaching === false) return false
          return sdk.client.session
            .get({ sessionID })
            .then((x) => !!x.data?.id && !x.data.time?.archived)
            .catch(() => true)
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
        // Seed the store from an on-device snapshot, so a cold open
        // paints real content before any network fetch. Mirrors loadMessages'
        // write (reconcile message + parts, set meta.limit) so the session reads
        // as `hydrated`; the caller then runs sync(id, force=true), which takes
        // the deltaMessages branch and fetches only the gap since the snapshot's
        // newest message id. No-op if a snapshot is missing, stale-versioned, or
        // the session already holds messages (a live open beat us to it).
        hydrate(snapshot: Snapshot) {
          const directory = sdk.directory
          const sessionID = snapshot.sessionID
          const key = keyFor(directory, sessionID)
          const [store, setStore] = globalSync.child(directory)
          if (store.message[sessionID] !== undefined) return
          if (meta.limit[key] !== undefined) return

          const messages = snapshot.messages.filter((m) => !!m?.id).sort((a, b) => cmp(a.id, b.id))
          if (messages.length === 0) return

          batch(() => {
            setStore(
              "session",
              produce((draft) => {
                const match = Binary.search(draft, sessionID, (s) => s.id)
                if (match.found) draft[match.index] = snapshot.session
                else draft.splice(match.index, 0, snapshot.session)
              }),
            )
            setStore("message", sessionID, reconcile(messages, { key: "id" }))
            for (const message of messages) {
              const parts = (snapshot.parts[message.id] ?? []).filter((p) => !!p?.id).sort((a, b) => cmp(a.id, b.id))
              setStore("part", message.id, reconcile(parts, { key: "id" }))
            }
            // Mark hydrated at the snapshot's window so sync(force) deltas instead
            // of re-fetching the tail. Never `complete`: the backfill-to-boundary
            // stays available behind the delta.
            setMeta("limit", key, messages.length)
            setMeta("complete", key, false)
          })
        },
        // Seed a just-created session into the store so the page it is about to
        // navigate to paints without waiting on the network. The creating client
        // already holds the full Info the GET would return, and a session that
        // has never been prompted has no messages to fetch, so both round trips
        // are pure latency in front of the first paint. CONTRACT: only for a
        // session created in THIS gesture — seeding one that already has server
        // state would mark an empty transcript hydrated and suppress the fetch
        // that would have filled it.
        seed(session: Session, directory?: string) {
          const dir = directory ?? sdk.directory
          const key = keyFor(dir, session.id)
          const [store, setStore] = globalSync.child(dir)
          if (store.message[session.id] !== undefined) return
          if (meta.limit[key] !== undefined) return

          batch(() => {
            setStore(
              "session",
              produce((draft) => {
                const match = Binary.search(draft, session.id, (s) => s.id)
                if (match.found) draft[match.index] = session
                else draft.splice(match.index, 0, session)
              }),
            )
            setStore("message", session.id, [])
            // limit is the loaded window, which is genuinely 0 here, and it
            // doubles as the hydrated flag (sync tests `!== undefined`, so 0
            // reads as hydrated). complete stops history.more() from paging
            // behind a session that has nothing behind it.
            setMeta("limit", key, 0)
            setMeta("complete", key, true)
          })
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

          // Re-arm the cache-ping daemon on every open AND fill the record if it
          // is missing, from ONE GET /session/:id. Fires UNCONDITIONALLY (before
          // the cached early-return below): arming is needed on every open, even
          // when the record is already cached, or reopening a loaded recent
          // session never re-arms. The promise is reused by both load paths
          // below so no path issues a second record fetch.
          const sessionReq = armAndFillSession(directory, client, setStore, sessionID)

          // Subscribe-before-snapshot: make sure the server has
          // this session in our event-interest set BEFORE we read its snapshot,
          // so any event fired after the snapshot arrives live and reconciles by
          // id instead of being dropped. Awaited here (not in the caller) so the
          // ordering holds no matter which path triggered the sync. Fail-open on
          // the server means a slow/failed subscribe over-sends, never drops.
          await globalSync.ensureInterest(sessionID, sdk.directory)

          // force re-fetch heals the reconnect gap: the server has no SSE replay,
          // so a message (or a part completed) during the disconnect window is
          // missing from the store. deltaMessages fetches only the gap (since the
          // second-newest known id) and merges by id, instead of re-downloading
          // the whole loaded window; it falls back to a full load when there is
          // no delta boundary yet.
          if (force && hydrated) {
            // deltaMessages touches only message/part, never session. A record
            // absent while messages are hydrated would otherwise never be
            // filled on this path, leaving getSession a permanent miss (blank
            // title). Wait on the session fetch (which fills it) alongside the
            // message heal, reusing that one fetch rather than issuing another.
            return Promise.all([
              sessionReq,
              deltaMessages({ directory, client, setStore, sessionID, limit: meta.limit[key]! }),
            ]).then(() => {})
          }

          if (hasSession && hasMessages && hydrated) return
          const pending = inflight.get(key)
          if (pending) return pending

          const count = store.message[sessionID]?.length ?? 0
          const full = hydrated ? (meta.limit[key] ?? chunk) : limitFor(count)
          // fresh bootstrap paints the tail first; a hydrated/resume load keeps
          // whatever was already loaded
          const initial = hydrated ? full : Math.min(tail, full)

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
          const list = store.session_diff[sessionID]
          const index = list?.findIndex((d) => d.file === file) ?? -1
          if (index === -1) return
          // Path-targeted write: only this row's body fields change, so the array
          // and every row's object identity stay stable. Rebuilding the array with
          // .map() would give the row a new identity and remount its accordion
          // item, collapsing what the user expanded.
          setStore("session_diff", sessionID, index, { before: body.before, after: body.after })
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
            // A queued heal targets a transcript that no longer exists, and
            // running it would refetch a session the user has left.
            pendingHeal.delete(key)
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
