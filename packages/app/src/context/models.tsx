import { createMemo } from "solid-js"
import { DateTime } from "luxon"
import { filter, firstBy, flat, groupBy, mapValues, pipe, uniqueBy, values } from "remeda"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useParams } from "@solidjs/router"
import { useProviders } from "@/hooks/use-providers"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { decode64 } from "@/utils/base64"
import { batched } from "@/utils/batched"

export type ModelKey = { providerID: string; modelID: string }

type Visibility = "show" | "hide"

export const { use: useModels, provider: ModelsProvider } = createSimpleContext({
  name: "Models",
  init: () => {
    const providers = useProviders()
    const params = useParams()
    const globalSDK = useGlobalSDK()
    const globalSync = useGlobalSync()

    // Model preferences are global and server-owned. Read from the current
    // directory's child store when a project is open, else the top-level store
    // (both carry the same value; the hub at "/" has no directory).
    const pref = createMemo(() => {
      const directory = decode64(params.dir)
      if (directory) return globalSync.child(directory)[0].model_preference
      return globalSync.data.model_preference
    })

    // A visibility change and a recent push land in the same tick when a model
    // is picked, each sending the whole preference document.
    const save = batched(pref, (doc) => {
      globalSDK.client.preference.model
        .set({ modelPreference: { user: doc.user, recent: doc.recent } })
        .catch(() => undefined)
    })

    const available = createMemo(() =>
      providers.connected().flatMap((p) =>
        Object.values(p.models).map((m) => ({
          ...m,
          provider: p,
        })),
      ),
    )

    const latest = createMemo(() =>
      pipe(
        available(),
        filter((x) => Math.abs(DateTime.fromISO(x.release_date).diffNow().as("months")) < 6),
        groupBy((x) => x.provider.id),
        mapValues((models) =>
          pipe(
            models,
            groupBy((x) => x.family),
            values(),
            (groups) =>
              groups.flatMap((g) => {
                const first = firstBy(g, [(x) => x.release_date, "desc"])
                return first ? [{ modelID: first.id, providerID: first.provider.id }] : []
              }),
          ),
        ),
        values(),
        flat(),
      ),
    )

    const latestSet = createMemo(() => new Set(latest().map((x) => `${x.providerID}:${x.modelID}`)))

    const visibility = createMemo(() => {
      const map = new Map<string, Visibility>()
      for (const item of pref().user) map.set(`${item.providerID}:${item.modelID}`, item.visibility)
      return map
    })

    const list = createMemo(() =>
      available().map((m) => ({
        ...m,
        name: m.name.replace("(latest)", "").trim(),
        latest: m.name.includes("(latest)"),
      })),
    )

    const find = (key: ModelKey) => list().find((m) => m.id === key.modelID && m.provider.id === key.providerID)

    function update(model: ModelKey, state: Visibility) {
      const user = pref().user.slice()
      const index = user.findIndex((x) => x.modelID === model.modelID && x.providerID === model.providerID)
      if (index >= 0) user[index] = { ...user[index], visibility: state }
      else user.push({ ...model, visibility: state })
      save({ user })
    }

    const visible = (model: ModelKey) => {
      const key = `${model.providerID}:${model.modelID}`
      const state = visibility().get(key)
      if (state === "hide") return false
      if (state === "show") return true
      if (latestSet().has(key)) return true
      const m = find(model)
      if (!m?.release_date || !DateTime.fromISO(m.release_date).isValid) return true
      return false
    }

    const setVisibility = (model: ModelKey, state: boolean) => {
      update(model, state ? "show" : "hide")
    }

    const push = (model: ModelKey) => {
      const uniq = uniqueBy([model, ...pref().recent], (x) => x.providerID + x.modelID)
      if (uniq.length > 5) uniq.pop()
      save({ recent: uniq })
    }

    return {
      ready: () => globalSync.ready,
      list,
      find,
      visible,
      setVisibility,
      recent: {
        list: createMemo(() => pref().recent),
        push,
      },
    }
  },
})
