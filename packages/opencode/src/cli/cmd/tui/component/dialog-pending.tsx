import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { createMemo, createSignal } from "solid-js"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useToast } from "../ui/toast"
import type { BackgroundGetPendingResponse } from "@opencode-ai/sdk/v2"
import { RGBA } from "@opentui/core"

type PendingResult = BackgroundGetPendingResponse[number]

function getRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)

  if (seconds < 60) return `${seconds}s ago`
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds}s`
}

export function DialogPending(props: { sessionID: string; pending: PendingResult[] }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()

  const [selected, setSelected] = createSignal<Set<string>>(new Set())

  const toggleSelection = (subagentId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(subagentId)) next.delete(subagentId)
      else next.add(subagentId)
      return next
    })
  }

  const selectAll = () => {
    setSelected(new Set(props.pending.map((p) => p.subagentId)))
  }

  const options = createMemo(() =>
    props.pending.map((pending) => {
      const isSelected = selected().has(pending.subagentId)
      return {
        title: pending.description,
        value: pending.subagentId,
        description: `${getRelativeTime(pending.completedAt)} · ${formatDuration(pending.duration)}`,
        footer: pending.agent,
        gutter: <text fg={isSelected ? theme.success : theme.text}>{isSelected ? "●" : "○"}</text>,
      }
    }),
  )

  const acceptSelected = async () => {
    const ids = Array.from(selected())
    if (ids.length === 0) {
      toast.show({ message: "No tasks selected", variant: "warning" })
      return
    }
    for (let i = 0; i < ids.length; i++) {
      const isLast = i === ids.length - 1
      await sdk.client.background.acceptPending({
        sessionID: props.sessionID,
        subagentId: ids[i],
        triggerLLM: isLast,
      })
    }
    sync.background.decrementPending(props.sessionID, ids.length)
    toast.show({ message: `Accepted ${ids.length} result${ids.length > 1 ? "s" : ""}`, variant: "success" })
    dialog.clear()
  }

  const acceptAll = async () => {
    const result = await sdk.client.background.acceptAllPending({ sessionID: props.sessionID, triggerLLM: true })
    sync.background.clearPending(props.sessionID)
    toast.show({ message: `Accepted ${result.data?.count ?? 0} results`, variant: "success" })
    dialog.clear()
  }

  return (
    <DialogSelect
      title="Pending Background Results"
      options={options()}
      skipFilter={true}
      onSelect={(option) => {
        toggleSelection(option.value)
      }}
      keybind={[
        {
          keybind: { name: "return", ctrl: false, meta: false, shift: false, leader: false },
          title: "select",
          onTrigger: (option) => toggleSelection(option.value),
        },
        {
          keybind: { name: "return", ctrl: false, meta: false, shift: true, leader: false },
          title: "submit selected",
          onTrigger: () => acceptSelected(),
        },
        {
          keybind: { name: "a", ctrl: true, meta: false, shift: false, leader: false },
          title: "select all",
          onTrigger: () => {
            if (selected().size === props.pending.length) {
              setSelected(new Set<string>())
            } else {
              selectAll()
            }
          },
        },
        {
          keybind: { name: "y", ctrl: false, meta: false, shift: false, leader: false },
          title: "accept all",
          onTrigger: () => acceptAll(),
        },
      ]}
    />
  )
}
