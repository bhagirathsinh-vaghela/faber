import { createStore, produce } from "solid-js/store"
import { batch, createEffect, createMemo, on, onCleanup } from "solid-js"
import { useLocation } from "@solidjs/router"
import { useShell } from "@/utils/mobile"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useSDK } from "./sdk"
import { useGlobalSDK } from "./global-sdk"
import { useSync } from "./sync"
import { base64Encode } from "@opencode-ai/util/encode"
import { useProviders } from "@/hooks/use-providers"
import { useModels } from "@/context/models"
import { defaultModelTicket } from "./global-sync"

export type ModelKey = { providerID: string; modelID: string }
type Held = {
  fresh?: boolean
  model?: ModelKey
  variant?: { value: string | undefined; sent?: boolean }
  pick?: ModelKey
}

// A store merges the next object written to a path into the node already there,
// so a model read from the store and kept past the next pick silently becomes
// that pick. Anything held across an await is copied out first.
const snapshot = (model?: ModelKey) => model && { providerID: model.providerID, modelID: model.modelID }

export const {
  use: useLocal,
  useOptional: useLocalOptional,
  provider: LocalProvider,
} = createSimpleContext({
  name: "Local",
  init: () => {
    const sdk = useSDK()
    const globalSDK = useGlobalSDK()
    const sync = useSync()
    const providers = useProviders()
    const location = useLocation()

    // The session id in the URL, if any. Model selection is per-session AND
    // per-tab: an open session's forward model is a pending pick held in THIS
    // tab (not persisted). The switcher is forward-looking — it sets the model
    // the next turn from this tab will use. On the new-session surface (no id)
    // selection falls back to the global default.
    const activeSessionID = createMemo(() => location.pathname.match(/\/session\/([^/?#]+)/)?.[1])

    function isModelValid(model: ModelKey) {
      const provider = providers.all().find((x) => x.id === model.providerID)
      return (
        !!provider?.models[model.modelID] &&
        providers
          .connected()
          .map((p) => p.id)
          .includes(model.providerID)
      )
    }

    function getFirstValidModel(...modelFns: (() => ModelKey | undefined)[]) {
      for (const modelFn of modelFns) {
        const model = modelFn()
        if (!model) continue
        if (isModelValid(model)) return model
      }
    }

    const agent = (() => {
      const list = createMemo(() => sync.data.agent.filter((x) => x.mode !== "subagent" && !x.hidden))
      const [store, setStore] = createStore<{
        current?: string
      }>({
        current: list()[0]?.name,
      })
      return {
        list,
        current() {
          const available = list()
          if (available.length === 0) return undefined
          return available.find((x) => x.name === store.current) ?? available[0]
        },
        set(name: string | undefined) {
          const available = list()
          if (available.length === 0) {
            setStore("current", undefined)
            return
          }
          if (name && available.some((x) => x.name === name)) {
            setStore("current", name)
            return
          }
          setStore("current", available[0].name)
        },
        move(direction: 1 | -1) {
          const available = list()
          if (available.length === 0) {
            setStore("current", undefined)
            return
          }
          let next = available.findIndex((x) => x.name === store.current) + direction
          if (next < 0) next = available.length - 1
          if (next >= available.length) next = 0
          const value = available[next]
          if (!value) return
          setStore("current", value.name)
          model.follow(value.model)
        },
      }
    })()

    const model = (() => {
      const models = useModels()

      // New-session surface (no session id) pending picks live here, per-tab.
      // `variantSet` tracks whether the variant was explicitly picked (so an
      // explicit "none" is distinguishable from "not picked"). Existing-session
      // picks live in bySession / variantBySession instead.
      const [ephemeral, setEphemeral] = createStore<{
        model?: ModelKey
        variant?: string
        variantSet: boolean
        bySession: Record<string, ModelKey>
        variantBySession: Record<string, string | undefined>
        handed: Record<string, { model?: ModelKey; variant?: { value: string | undefined } }>
        spent: number
      }>({
        model: undefined,
        variant: undefined,
        variantSet: false,
        bySession: {},
        variantBySession: {},
        handed: {},
        spent: 0,
      })

      // The last user message: the baseline only for a session record that
      // predates `current` (see lastMessageModel).
      const lastMessage = (sessionID: string) => sync.data.message[sessionID]?.findLast((m) => m.role === "user")
      const sameModel = (a?: ModelKey, b?: ModelKey) =>
        !!a && !!b && a.providerID === b.providerID && a.modelID === b.modelID

      // The session record's `current` is what the server inherits when a prompt
      // names nothing, so it is the baseline; the last message stands in only
      // for a record that predates it. The variant baseline reads the same way.
      const lastMessageModel = (sessionID: string) =>
        sync.session.get(sessionID)?.current?.model ?? lastMessage(sessionID)?.model

      // The server owns this resolution, so the chip and the turn cannot
      // disagree. The recent list is history for the picker only and
      // deliberately does NOT drive the default; only settings does.
      const fallbackModel = createMemo<ModelKey | undefined>(() => {
        const resolved = sync.data.default_model
        if (!resolved) return undefined
        return { providerID: resolved.providerID, modelID: resolved.modelID }
      })

      // Entering the new-session surface re-reads the server's resolution, so a
      // config edit on disk since page load shows before the first send.
      createEffect(
        on(activeSessionID, (id) => {
          if (id) return
          const latest = defaultModelTicket(sdk.directory)
          sdk.client.provider
            .default()
            .then((x) => {
              if (!latest()) return
              sync.set("default_model", x.data ?? null)
            })
            .catch(() => undefined)
        }),
      )

      // A handed-over pick was spent by the send that carried it. Left in place it
      // would ride on a later send whenever the record's `current` says something
      // else (another tab's pick, a shell send that moves nothing), so it goes once
      // the record lands, whatever that record holds. A pick changed since the
      // hand-over is the user's own and stays.
      createEffect(() => {
        const synced = Object.keys(ephemeral.handed).filter((id) => sync.session.get(id)?.current)
        if (synced.length === 0) return
        setEphemeral(
          produce((s) => {
            synced.forEach((id) => {
              const handed = s.handed[id]
              if (sameModel(s.bySession[id], handed.model)) delete s.bySession[id]
              if (handed.variant && id in s.variantBySession && s.variantBySession[id] === handed.variant.value)
                delete s.variantBySession[id]
              delete s.handed[id]
            })
          }),
        )
      })

      const current = createMemo(() => {
        // Open session: this tab's pending pick wins, else the model the last
        // turn ran, else the global default. New-session surface: the tab-wide
        // ephemeral pick, else the global default.
        const id = activeSessionID()
        const key = id
          ? getFirstValidModel(
              () => ephemeral.bySession[id],
              () => lastMessageModel(id),
              fallbackModel,
            )
          : getFirstValidModel(() => ephemeral.model, fallbackModel)
        if (!key) return undefined
        return models.find(key)
      })

      // The forward pick differs from its baseline. Baseline is the session's
      // `current` (else its last user message) for an open session, or the
      // global default for the new-session surface. A successful send spends
      // the pick, so the dot clears; it also clears when the pick matches the
      // baseline again. Model and variant get independent dots.

      // The model a prompt carries: only one this tab explicitly picked. For an
      // open session a pick equal to what the session last ran is no change, so
      // it is omitted too; the server then runs the session's own `current`.
      // Undefined is meaningful to the caller: omitting the model lets the
      // server resolve it, never this tab's copy of it.
      const picked = createMemo<ModelKey | undefined>(() => {
        const id = activeSessionID()
        if (!id) {
          const pick = getFirstValidModel(() => ephemeral.model)
          return pick && !sameModel(pick, fallbackModel()) ? snapshot(pick) : undefined
        }
        const pick = getFirstValidModel(() => ephemeral.bySession[id])
        return pick && !sameModel(pick, lastMessageModel(id)) ? snapshot(pick) : undefined
      })

      // The variant that will actually ride on the next prompt, and the baseline
      // the pending dot is measured against. A variant only makes sense relative
      // to the model that offers it: undefined ("no variant") is always valid, a
      // named variant must be a key in the current model's variants. Candidates
      // are walked in priority order and the first the model offers wins; a pick
      // the newly-switched model does not offer is skipped, so the variant resets
      // to the server's default instead of carrying a meaningless value forward.
      const resolveVariant = () => {
        const m = current()
        if (!m) return { value: undefined, baseline: undefined, base: undefined }
        const offered = (value: string | undefined) => value === undefined || !!m.variants?.[value]
        const key = { providerID: m.provider.id, modelID: m.id }
        // Mirrors the server's `defaults(agent, model)`: the agent's variant when
        // this model offers it, else the model's own. The server's answer is
        // reused only when it was resolved for this same model and agent.
        const resolved = sync.data.default_model
        const name = agent.current()?.name
        const own = agent.current()?.variant
        const server =
          resolved && sameModel(resolved, key) && resolved.agent === name
            ? resolved.variant
            : own && m.variants?.[own]
              ? own
              : m.variant
        const base = offered(server) ? server : undefined
        const id = activeSessionID()
        if (id) {
          // The record's `current` is what the server inherits; the message scan
          // stands in only for a record that predates it.
          const session = sync.session.get(id)?.current
          const named = session
            ? undefined
            : sync.data.message[id]?.findLast((msg) => msg.role === "user" && msg.variant !== undefined)
          const baseline = session
            ? sameModel(session.model, key) && offered(session.variant)
              ? session.variant
              : base
            : named?.role === "user" && sameModel(named.model, key)
              ? named.variant
              : base
          if (id in ephemeral.variantBySession && offered(ephemeral.variantBySession[id]))
            return { value: ephemeral.variantBySession[id], baseline, base }
          return { value: baseline, baseline, base }
        }
        if (ephemeral.variantSet && offered(ephemeral.variant))
          return { value: ephemeral.variant, baseline: base, base }
        return { value: base, baseline: base, base }
      }

      const pendingModel = createMemo(() => {
        const id = activeSessionID()
        if (id) {
          const picked = ephemeral.bySession[id]
          if (!picked) return false
          const last = lastMessageModel(id)
          if (!last) return false
          return !sameModel(picked, last)
        }
        if (!ephemeral.model) return false
        return !sameModel(ephemeral.model, fallbackModel())
      })

      // A "Default" pick is stored as undefined; it is no change when what the
      // session runs already is the default variant.
      const changed = (resolved: ReturnType<typeof resolveVariant>) => {
        const runs = resolved.baseline ?? resolved.base
        return resolved.value === undefined ? runs !== resolved.base : resolved.value !== runs
      }

      const pendingVariant = createMemo(() => changed(resolveVariant()))

      const recent = createMemo(() => models.recent.list().map(models.find).filter(Boolean))

      const cycle = (direction: 1 | -1) => {
        const recentList = recent()
        const currentModel = current()
        if (!currentModel) return

        const index = recentList.findIndex(
          (x) => x?.provider.id === currentModel.provider.id && x?.id === currentModel.id,
        )
        if (index === -1) return

        let next = index + direction
        if (next < 0) next = recentList.length - 1
        if (next >= recentList.length) next = 0

        const val = recentList[next]
        if (!val) return

        model.set({
          providerID: val.provider.id,
          modelID: val.id,
        })
      }

      return {
        ready: models.ready,
        current,
        picked,
        default: fallbackModel,
        pendingModel,
        pendingVariant,
        recent,
        list: models.list,
        cycle,
        // Cycling agents is not a model pick, so it writes none of its own. It can
        // change only what a send naming no model would run: a session with no
        // `current` runs its agent's configured model, so the dock follows that,
        // unless a pick already stands. A session's own `current` keeps its model.
        follow(own?: ModelKey) {
          const id = activeSessionID()
          const now = current()
          if (!own || (id && sync.session.get(id)?.current) || pendingModel()) return
          if (now && sameModel(own, { providerID: now.provider.id, modelID: now.id })) return
          model.set(own)
        },
        // Sends spent so far. Shown on the dock trigger so a test can wait for a
        // send to settle instead of guessing.
        spent: () => ephemeral.spent,
        // This tab's picks for the open session, captured when a send starts.
        // On the new-session surface these are the tab-wide picks, marked
        // `fresh` so `spend` moves them onto the created session. `model` and
        // `variant.sent` are what the request carried; `pick` and `variant.value`
        // are the raw picks as they stood, sent or not.
        held(): Held {
          const id = activeSessionID()
          if (!id)
            return {
              fresh: true,
              model: picked(),
              pick: snapshot(ephemeral.model),
              variant: ephemeral.variantSet ? { value: ephemeral.variant, sent: changed(resolveVariant()) } : undefined,
            }
          return {
            model: snapshot(ephemeral.bySession[id]),
            variant: id in ephemeral.variantBySession ? { value: ephemeral.variantBySession[id] } : undefined,
          }
        },
        // A send that reached the server carried the picks it captured, so the
        // session's own record is the baseline from here. Only what that send
        // carried is spent: a pick made while it was in flight stays, and a
        // failed send keeps them all for the retry. A fresh send hands its picks
        // to the created session, whose record has not synced yet, so the dock
        // keeps showing what was sent; once `current` lands they equal the
        // baseline and ride on nothing. Only a variant the send carried is handed
        // over, and nothing is handed to a session created in another directory
        // (a worktree), whose record never syncs into this store.
        spend(sessionID: string, sent: Held, directory = sdk.directory) {
          setEphemeral(
            produce((s) => {
              s.spent += 1
              if (sent.fresh) {
                const here = directory === sdk.directory
                const model = here ? snapshot(sent.model) : undefined
                const variant = here && sent.variant?.sent ? sent.variant : undefined
                if (model && !s.bySession[sessionID]) s.bySession[sessionID] = model
                if (variant && !(sessionID in s.variantBySession)) s.variantBySession[sessionID] = variant.value
                if (model || variant)
                  s.handed[sessionID] = { model: snapshot(model), variant: variant && { value: variant.value } }
                // Cleared by what stood, not by what was sent: a pick reset to
                // the default sends nothing, and would ride once the default moves.
                if (sent.pick && sameModel(s.model, sent.pick)) s.model = undefined
                if (sent.variant && s.variantSet && s.variant === sent.variant.value) {
                  s.variant = undefined
                  s.variantSet = false
                }
                return
              }
              // Accepted flicker until session.updated: handing an open session's pick over would let it ride again.
              if (sent.model && sameModel(s.bySession[sessionID], sent.model)) delete s.bySession[sessionID]
              if (
                sent.variant &&
                sessionID in s.variantBySession &&
                s.variantBySession[sessionID] === sent.variant.value
              )
                delete s.variantBySession[sessionID]
            }),
          )
        },
        set(model: ModelKey | undefined, options?: { recent?: boolean }) {
          // Open session: the switch is a per-tab, per-session pending pick. It
          // rides on the next prompt from this tab as input.model and does NOT
          // touch the global recent list/default or any server state. Two tabs
          // on the same idle session can each pick independently; whichever
          // sends first wins for that turn.
          const id = activeSessionID()
          if (id && model) {
            models.setVisibility(model, true)
            setEphemeral("bySession", id, model)
            // Variant is model-scoped; a new model invalidates a prior per-session
            // variant pick. Drop the key so variant.current() falls back to the
            // newly picked model's default.
            setEphemeral(
              "variantBySession",
              produce((v) => {
                delete v[id]
              }),
            )
            return
          }
          // New-session surface: a per-tab pending pick. Push to the recent list
          // for the picker's history, but do NOT write config.model — the global
          // default only changes via settings, so a new session shows a pending
          // dot when its pick differs from that default.
          batch(() => {
            setEphemeral("model", model)
            if (model) models.setVisibility(model, true)
            if (options?.recent && model) models.recent.push(model)
          })
        },
        visible(model: ModelKey) {
          return models.visible(model)
        },
        setVisibility(model: ModelKey, visible: boolean) {
          models.setVisibility(model, visible)
        },
        variant: {
          current() {
            return resolveVariant().value
          },
          // The variant a prompt carries: only an explicit pick that differs from
          // its baseline (what the session last ran, or the server default on the
          // new-session surface). Anything else is omitted so the server
          // resolves it, and a picker value that drifted without a pick can never
          // change a turn. A pick of "Default" is sent as "default": omitted, the
          // server would inherit the session's old variant instead.
          request() {
            const resolved = resolveVariant()
            if (!changed(resolved)) return undefined
            return resolved.value ?? "default"
          },
          list() {
            const m = current()
            if (!m) return []
            if (!m.variants) return []
            return Object.keys(m.variants)
          },
          set(value: string | undefined) {
            const m = current()
            if (!m) return
            const id = activeSessionID()
            if (id) {
              setEphemeral("variantBySession", id, value)
              return
            }
            // New-session surface: a per-tab pending pick.
            batch(() => {
              setEphemeral("variant", value)
              setEphemeral("variantSet", true)
            })
          },
          cycle() {
            const variants = this.list()
            if (variants.length === 0) return
            const currentVariant = this.current()
            if (!currentVariant) {
              this.set(variants[0])
              return
            }
            const index = variants.indexOf(currentVariant)
            if (index === -1 || index === variants.length - 1) {
              this.set(undefined)
              return
            }
            this.set(variants[index + 1])
          },
        },
      }
    })()

    const skill = (() => {
      const [store, setStore] = createStore<{ favorite: string[] }>({ favorite: [] })

      sdk.client.app.skillFavorites().then((res) => {
        if (res.data) setStore("favorite", res.data)
      })

      const persist = (favorite: string[]) => {
        setStore("favorite", favorite)
        sdk.client.app.setSkillFavorites({ body: favorite })
      }

      return {
        favorite: createMemo(() => store.favorite),
        isFavorite(name: string) {
          return store.favorite.includes(name)
        },
        toggleFavorite(name: string) {
          const exists = store.favorite.includes(name)
          persist(exists ? store.favorite.filter((x) => x !== name) : [name, ...store.favorite])
        },
      }
    })()

    const dock = (() => {
      // Per-surface VISIBLE field-id sets. Server seeds the
      // defaults when no config exists, so an empty initial store is just
      // the pre-load state. `surface()` picks which set the render sites read.
      const [store, setStore] = createStore<{ desktop: string[]; mobile: string[] }>({ desktop: [], mobile: [] })
      const shell = useShell()
      // The two stored sets are a server schema (setDockConfig), so the size
      // class maps onto them rather than replacing them: anything with room for
      // more than one pane reads the roomier set.
      const surface = createMemo(() => (shell.wide() ? "desktop" : "mobile"))

      sdk.client.app.dockConfig().then((res) => {
        if (res.data) setStore(res.data)
      })

      // Any client's toggle broadcasts dock.updated on the global stream, so
      // every other open client applies the change live without a reload.
      const unsub = globalSDK.event.on("global", (event) => {
        if (event.type !== "dock.updated") return
        setStore(event.properties)
      })
      onCleanup(unsub)

      return {
        isDesktop: shell.wide,
        // The active surface's visible set, as a memo for render gating.
        visible: createMemo(() => store[surface()]),
        list: (s: "desktop" | "mobile") => store[s],
        isVisible(id: string) {
          return store[surface()].includes(id)
        },
        // The titlebar renders BOTH rows and lets CSS hide one, so a row knows
        // which surface it is more precisely than `surface()` can: that memo
        // reads `wide()`, which is true from 600px, while the rows split at the
        // 840px `expanded` breakpoint. A tablet between the two would otherwise
        // show the mobile row while obeying the desktop set.
        isVisibleOn(s: "desktop" | "mobile", id: string) {
          return store[s].includes(id)
        },
        toggle(s: "desktop" | "mobile", id: string) {
          const has = store[s].includes(id)
          setStore(s, has ? store[s].filter((x) => x !== id) : [...store[s], id])
          sdk.client.app.setDockConfig({ desktop: store.desktop, mobile: store.mobile })
        },
      }
    })()

    const result = {
      slug: createMemo(() => base64Encode(sdk.directory)),
      model,
      agent,
      skill,
      dock,
    }
    return result
  },
})
