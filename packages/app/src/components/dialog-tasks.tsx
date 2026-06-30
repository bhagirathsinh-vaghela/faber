import { Component, createMemo, createResource, createSignal, onCleanup, Show } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Icon } from "@opencode-ai/ui/icon"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import type { BackgroundTask } from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/util/encode"

type Tab = "running" | "completed"

function duration(task: BackgroundTask): string {
  const end = task.time.completed ?? Date.now()
  return `${Math.round((end - task.time.created) / 1000)}s`
}

function StatusIcon(props: { status: BackgroundTask["status"] }) {
  return (
    <Show when={props.status !== "running"} fallback={<Spinner />}>
      <Icon
        name={props.status === "completed" ? "circle-check" : "circle-x"}
        class={props.status === "completed" ? "text-success" : "text-error"}
      />
    </Show>
  )
}

export const DialogTasks: Component = () => {
  const sdk = useSDK()
  const params = useParams()
  const navigate = useNavigate()
  const dialog = useDialog()
  const language = useLanguage()
  const [tab, setTab] = createSignal<Tab>("running")

  const [tasks, { refetch }] = createResource(
    () => params.id,
    async (sessionID) => {
      const res = await sdk.client.background.list({ sessionID })
      return res.data ?? []
    },
  )

  const interval = setInterval(() => refetch(), 2000)
  onCleanup(() => clearInterval(interval))

  const running = createMemo(() =>
    (tasks() ?? []).filter((t) => t.status === "running").toSorted((a, b) => b.time.created - a.time.created),
  )

  const completed = createMemo(() =>
    (tasks() ?? [])
      .filter((t) => t.status !== "running")
      .toSorted((a, b) => (b.time.completed ?? b.time.created) - (a.time.completed ?? a.time.created)),
  )

  const items = createMemo(() => (tab() === "running" ? running() : completed()))

  const select = (task: BackgroundTask | undefined) => {
    if (!task?.subagent?.sessionID) return
    dialog.close()
    navigate(`/${base64Encode(sdk.directory)}/session/${task.subagent.sessionID}`)
  }

  const cancel = async (task: BackgroundTask) => {
    await sdk.client.background.cancel({ id: task.id })
    refetch()
  }

  return (
    <Dialog title={language.t("dialog.tasks.title")}>
      <div data-slot="tasks-tabs" class="flex gap-1 px-2 pb-2 shrink-0">
        <button
          class="px-2 py-0.5 rounded text-sm font-normal"
          classList={{ "bg-surface text-text": tab() === "running", "text-text-weak": tab() !== "running" }}
          onClick={() => setTab("running")}
        >
          {language.t("dialog.tasks.tab.running", { count: running().length })}
        </button>
        <button
          class="px-2 py-0.5 rounded text-sm font-normal"
          classList={{ "bg-surface text-text": tab() === "completed", "text-text-weak": tab() !== "completed" }}
          onClick={() => setTab("completed")}
        >
          {language.t("dialog.tasks.tab.completed", { count: completed().length })}
        </button>
      </div>
      <List
        class="flex-1 min-h-0 [&_[data-slot=list-search-wrapper]]:sr-only [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0"
        search={{ autofocus: true }}
        emptyMessage={language.t(tab() === "running" ? "dialog.tasks.empty.running" : "dialog.tasks.empty.completed")}
        key={(x) => x.id}
        items={items}
        onSelect={select}
        onKeyEvent={(event, task) => {
          if (event.key === "Tab") {
            event.preventDefault()
            setTab((prev) => (prev === "running" ? "completed" : "running"))
          }
          if (event.key.toLowerCase() === "x" && !event.ctrlKey && !event.metaKey && task?.status === "running") {
            event.preventDefault()
            cancel(task)
          }
        }}
      >
        {(task) => (
          <div class="w-full flex items-center gap-2">
            <StatusIcon status={task.status} />
            <div class="flex-1 min-w-0 flex flex-col text-left">
              <span class="truncate font-normal">{task.description}</span>
              <span class="truncate text-text-weak font-normal">
                {(task.subagent?.agent ?? task.type) + " · " + duration(task)}
              </span>
            </div>
          </div>
        )}
      </List>
    </Dialog>
  )
}
