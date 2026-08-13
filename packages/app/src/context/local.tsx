import { createStore, produce } from "solid-js/store"
import { batch, createMemo, onCleanup } from "solid-js"
import { useLocation } from "@solidjs/router"
import { createMediaQuery } from "@solid-primitives/media"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useSDK } from "./sdk"
import { useGlobalSDK } from "./global-sdk"
import { useSync } from "./sync"
import { base64Encode } from "@opencode-ai/util/encode"
import { useProviders } from "@/hooks/use-providers"
import { useModels } from "@/context/models"

export type ModelKey = { providerID: string; modelID: string }

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
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
          const currentModel = model.current()
          let next = available.findIndex((x) => x.name === store.current) + direction
          if (next < 0) next = available.length - 1
          if (next >= available.length) next = 0
          const value = available[next]
          if (!value) return
          setStore("current", value.name)
          if (currentModel) {
            queueMicrotask(() =>
              model.set({
                providerID: currentModel.provider.id,
                modelID: currentModel.id,
              }),
            )
            queueMicrotask(() => sync.set("config", "model", currentModel.provider.id + "/" + currentModel.id))
          }
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
      }>({
        model: undefined,
        variant: undefined,
        variantSet: false,
        bySession: {},
        variantBySession: {},
      })

      // The model the last turn in this session actually ran, read from the
      // last user message. Used as the forward-model fallback (until this tab
      // picks something) and as the baseline for the pending indicator.
      const lastMessage = (sessionID: string) => sync.data.message[sessionID]?.findLast((m) => m.role === "user")
      const lastMessageModel = (sessionID: string) => lastMessage(sessionID)?.model

      // The server owns this resolution, so the chip and the turn cannot
      // disagree. The recent list is history for the picker only and
      // deliberately does NOT drive the default; only settings does.
      const fallbackModel = createMemo<ModelKey | undefined>(() => sync.data.default_model ?? undefined)

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

      // Undefined is meaningful to the caller: omitting the model from a prompt
      // lets the server resolve it off disk at turn time, so a config edit since
      // this tab last fetched still takes effect.
      const picked = createMemo<ModelKey | undefined>(() => {
        const id = activeSessionID()
        if (id) return getFirstValidModel(() => ephemeral.bySession[id], () => lastMessageModel(id))
        return getFirstValidModel(() => ephemeral.model)
      })

      // The forward pick differs from its baseline. Baseline is the last turn's
      // model/variant for an open session, or the global default for the
      // new-session surface. Existing-session dot clears when the next turn
      // stamps the pick onto a message; new-session dot clears when the pick
      // matches the global default again. Model and variant get independent dots.
      const sameModel = (a?: ModelKey, b?: ModelKey) =>
        !!a && !!b && a.providerID === b.providerID && a.modelID === b.modelID

      // The variant that will actually ride on the next prompt, and the baseline
      // the pending dot is measured against. A variant only makes sense relative
      // to the model that offers it: undefined ("no variant") is always valid, a
      // named variant must be a key in the current model's variants. Candidates
      // are walked in priority order and the first the model offers wins; a pick
      // the newly-switched model does not offer is skipped, so the variant resets
      // to that model's global preference instead of carrying a meaningless value
      // forward.
      const resolveVariant = () => {
        const m = current()
        if (!m) return { value: undefined, baseline: undefined }
        const offered = (value: string | undefined) => value === undefined || !!m.variants?.[value]
        const pref = models.variant.get({ providerID: m.provider.id, modelID: m.id })
        const base = offered(pref) ? pref : undefined
        const id = activeSessionID()
        if (id) {
          const last = lastMessage(id)
          const baseline =
            last && sameModel(last.model, { providerID: m.provider.id, modelID: m.id }) && offered(last.variant)
              ? last.variant
              : base
          if (id in ephemeral.variantBySession && offered(ephemeral.variantBySession[id]))
            return { value: ephemeral.variantBySession[id], baseline }
          return { value: baseline, baseline }
        }
        if (ephemeral.variantSet && offered(ephemeral.variant)) return { value: ephemeral.variant, baseline: base }
        return { value: base, baseline: base }
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

      const pendingVariant = createMemo(() => {
        const resolved = resolveVariant()
        return resolved.value !== resolved.baseline
      })

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
            // global preference for the newly picked model.
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
            const next = model ?? fallbackModel()
            setEphemeral("model", next)
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
            // New-session surface: a per-tab pending pick, not the global pref.
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
      // the pre-load state. `isDesktop` mirrors the 768px breakpoint used in
      // session.tsx; `surface()` picks which set the render sites read.
      const [store, setStore] = createStore<{ desktop: string[]; mobile: string[] }>({ desktop: [], mobile: [] })
      const desktop = createMediaQuery("(min-width: 768px)")

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

      const surface = (): "desktop" | "mobile" => (desktop() ? "desktop" : "mobile")

      return {
        isDesktop: desktop,
        // The active surface's visible set, as a memo for render gating.
        visible: createMemo(() => store[surface()]),
        list: (s: "desktop" | "mobile") => store[s],
        isVisible(id: string) {
          return store[surface()].includes(id)
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
