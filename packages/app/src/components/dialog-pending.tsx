import { Component, createMemo, createResource, createSignal, onCleanup } from "solid-js"
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

  const [pending, { refetch }] = createResource(
    () => params.id,
    async (sessionID) => {
      const res = await sdk.client.background.getPending({ sessionID })
      return res.data ?? []
    },
  )

  const interval = setInterval(() => refetch(), 2000)
  onCleanup(() => clearInterval(interval))

  const items = createMemo(() => pending() ?? [])

  const toggle = (taskId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }

  const toggleAll = () => {
    const all = items()
    setSelected((prev) => (prev.size === all.length ? new Set<string>() : new Set(all.map((p) => p.taskId))))
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
        taskId: ids[i],
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
        key={(x) => x.taskId}
        items={items}
        onSelect={(p) => p && toggle(p.taskId)}
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
              name={selected().has(p.taskId) ? "circle-check" : "circle-x"}
              class={selected().has(p.taskId) ? "text-success" : "text-text-weak opacity-40"}
            />
            <div class="flex-1 min-w-0 flex flex-col text-left">
              <span class="truncate font-normal">{p.description}</span>
              <span class="truncate text-text-weak font-normal">
                {(p.agent ?? p.type) + " · " + elapsed(p.duration)}
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
