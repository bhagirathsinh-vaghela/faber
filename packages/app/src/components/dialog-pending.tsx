import { Component, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useParams } from "@solidjs/router"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import type { BackgroundGetPendingResponse } from "@opencode-ai/sdk/v2/client"

type PendingResult = BackgroundGetPendingResponse[number]

function elapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export const DialogPending: Component = () => {
  const sdk = useSDK()
  const params = useParams()
  const dialog = useDialog()
  const language = useLanguage()
  const [selected, setSelected] = createSignal(new Set<string>())

  // Same pattern as PromptActionBar: seed once on mount, then append from the
  // result_pending event. NOT createResource — its pending state suspends the
  // <Suspense> around <Session> and flickers the transcript on open and on every
  // 2s poll. A plain store fed by the event never suspends. Accepting a result
  // closes the dialog, so the seed re-reads fresh on the next open (the server
  // clears silently, matching how PromptActionBar tracks the available count).
  const [pending, setPending] = createStore<PendingResult[]>([])

  onMount(async () => {
    const sessionID = params.id
    if (!sessionID) return
    const res = await sdk.client.background.getPending({ sessionID })
    setPending(reconcile(res.data ?? [], { key: "subagentId" }))
  })

  const unsub = sdk.event.on("background.subagent.result_pending", (evt) => {
    if (evt.properties.sessionID !== params.id) return
    setPending(
      produce((list) => {
        if (!list.some((p) => p.subagentId === evt.properties.pending.subagentId)) list.push(evt.properties.pending)
      }),
    )
  })
  onCleanup(() => unsub())

  const items = createMemo(() => pending)

  const toggle = (subagentId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(subagentId)) next.delete(subagentId)
      else next.add(subagentId)
      return next
    })
  }

  const toggleAll = () => {
    const all = items()
    setSelected((prev) => (prev.size === all.length ? new Set<string>() : new Set(all.map((p) => p.subagentId))))
  }

  const acceptSelected = async () => {
    const ids = Array.from(selected())
    if (ids.length === 0) {
      showToast({ title: language.t("dialog.pending.none") })
      return
    }
    for (let i = 0; i < ids.length; i++) {
      await sdk.client.background.acceptPending({
        sessionID: params.id!,
        subagentId: ids[i],
        triggerLLM: i === ids.length - 1,
      })
    }
    dialog.close()
    showToast({ title: language.t("dialog.pending.accepted", { count: ids.length }), variant: "success" })
  }

  const acceptAll = async () => {
    const res = await sdk.client.background.acceptAllPending({ sessionID: params.id!, triggerLLM: true })
    dialog.close()
    showToast({ title: language.t("dialog.pending.accepted", { count: res.data?.count ?? 0 }), variant: "success" })
  }

  return (
    <Dialog title={language.t("dialog.pending.title")}>
      <List
        class="flex-1 min-h-0 [&_[data-slot=list-search-wrapper]]:sr-only [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0"
        search={{ autofocus: true }}
        emptyMessage={language.t("dialog.pending.empty")}
        key={(x) => x.subagentId}
        items={items}
        onSelect={(p) => p && toggle(p.subagentId)}
        onKeyEvent={(event, p) => {
          if (event.ctrlKey && event.key.toLowerCase() === "a") {
            event.preventDefault()
            toggleAll()
          }
          if (event.shiftKey && event.key === "Enter") {
            event.preventDefault()
            acceptSelected()
          }
          if (event.key.toLowerCase() === "y" && !event.ctrlKey && !event.metaKey && !p) {
            event.preventDefault()
            acceptAll()
          }
        }}
      >
        {(p) => (
          <div class="w-full flex items-center gap-2">
            <Icon
              name={selected().has(p.subagentId) ? "circle-check" : "circle-x"}
              class={selected().has(p.subagentId) ? "text-success" : "text-text-weak opacity-40"}
            />
            <div class="flex-1 min-w-0 flex flex-col text-left">
              <span class="truncate font-normal">{p.description}</span>
              <span class="truncate text-text-weak font-normal">
                {(p.agent ?? "subagent") + " · " + elapsed(p.duration)}
              </span>
            </div>
          </div>
        )}
      </List>
      <div class="flex gap-2 justify-end px-2 pt-2 shrink-0">
        <Button variant="ghost" onClick={acceptSelected}>
          {language.t("dialog.pending.acceptSelected")}
        </Button>
        <Button onClick={acceptAll}>{language.t("dialog.pending.acceptAll")}</Button>
      </div>
    </Dialog>
  )
}
