import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { createMemo, createSignal, createResource, onCleanup } from "solid-js"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { useTheme } from "@tui/context/theme"
import { useKeyboard } from "@opentui/solid"
import { Locale } from "@/util/locale"
import { Spinner } from "./spinner"

type Tab = "running" | "completed"

function StatusGutter(props: { status: string }) {
  const { theme } = useTheme()
  if (props.status === "running") return <Spinner />
  if (props.status === "completed") return <text fg={theme.success}>{"\u2714"}</text>
  if (props.status === "cancelled") return <text fg={theme.warning}>{"\u2718"}</text>
  return <text fg={theme.error}>{"\u2757"}</text>
}

export function DialogSubagents() {
  const sdk = useSDK()
  const route = useRoute()
  const [tab, setTab] = createSignal<Tab>("running")

  // Handle Tab key at this level so it always works regardless of selection state
  useKeyboard((evt) => {
    if (evt.name === "tab" && !evt.ctrl && !evt.meta && !evt.shift) {
      evt.preventDefault()
      setTab((prev) => (prev === "running" ? "completed" : "running"))
    }
  })

  const [tasks, { refetch }] = createResource(
    () => (route.data.type === "session" ? route.data.sessionID : undefined),
    async (sessionID) => {
      const result = await sdk.client.background.list({ sessionID })
      return result.data ?? []
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

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const items = tab() === "running" ? running() : completed()
    if (items.length === 0) {
      return [
        {
          title: tab() === "running" ? "No running subagents" : "No completed subagents",
          value: "",
          disabled: true,
        },
      ]
    }
    return items.map((t) => {
      const agent = t.subagent?.agent ?? "subagent"
      const duration = t.time.completed
        ? `${Math.round((t.time.completed - t.time.created) / 1000)}s`
        : `${Math.round((Date.now() - t.time.created) / 1000)}s`
      const status =
        t.status === "running"
          ? "running"
          : t.status === "completed"
            ? "done"
            : t.status === "cancelled"
              ? "cancelled"
              : "failed"
      return {
        title: `${t.description}`,
        description: `${agent} · ${status} · ${duration}`,
        value: t.subagent?.sessionID ?? t.id,
        footer: Locale.time(t.time.created),
        gutter: <StatusGutter status={t.status} />,
        onSelect: (ctx) => {
          if (t.subagent?.sessionID) {
            route.navigate({ type: "session", sessionID: t.subagent.sessionID })
          }
          ctx.clear()
        },
      }
    })
  })

  const title = createMemo(() => {
    const r = running().length
    const c = completed().length
    return tab() === "running" ? `Subagents · Running (${r})` : `Subagents · Completed (${c})`
  })

  return (
    <DialogSelect
      title={title()}
      options={options()}
      skipFilter={true}
      keybind={[
        {
          keybind: { name: "tab", ctrl: false, meta: false, shift: false, leader: false },
          title: tab() === "running" ? "Completed" : "Running",
          onTrigger: () => {},
        },
        ...(tab() === "running"
          ? [
              {
                keybind: { name: "x", ctrl: false, meta: false, shift: false, leader: false },
                title: "Cancel",
                onTrigger: async (option: DialogSelectOption<string>) => {
                  if (!option.value) return
                  const task = (tasks() ?? []).find(
                    (t) => (t.subagent?.sessionID ?? t.id) === option.value && t.status === "running",
                  )
                  if (task) {
                    await sdk.client.background.cancel({ id: task.id })
                    refetch()
                  }
                },
              },
            ]
          : []),
      ]}
    />
  )
}
