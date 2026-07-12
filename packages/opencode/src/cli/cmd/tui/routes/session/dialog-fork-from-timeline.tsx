import { createMemo, createSignal, onMount } from "solid-js"
import { useSync } from "@tui/context/sync"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import type { TextPart } from "@opencode-ai/sdk/v2"
import { Locale } from "@/util/locale"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { useDialog } from "../../ui/dialog"
import type { PromptInfo } from "@tui/component/prompt/history"

export function DialogForkFromTimeline(props: {
  sessionID: string
  onMove: (messageID: string) => void
  setPrompt: (promptInfo: PromptInfo) => void
  onReverted: () => void
}) {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const route = useRoute()
  const [mode, setMode] = createSignal<"fork" | "revert">("revert")

  onMount(() => {
    dialog.setSize("large")
  })

  const options = createMemo((): DialogSelectOption<string>[] => {
    const messages = sync.data.message[props.sessionID] ?? []
    const revert = mode() === "revert"
    const result = [] as DialogSelectOption<string>[]
    for (const message of messages) {
      if (message.role !== "user") continue
      if (message.synthetic) continue
      const part = (sync.data.part[message.id] ?? []).find(
        (x) => x.type === "text" && !x.synthetic && !x.ignored,
      ) as TextPart
      if (!part) continue
      result.push({
        title: part.text.replace(/\n/g, " "),
        value: message.id,
        footer: Locale.time(message.time.created),
        onSelect: revert
          ? async (dialog) => {
              if (sync.data.session_busy?.[props.sessionID]?.busy)
                await sdk.client.session.abort({ sessionID: props.sessionID }).catch(() => {})
              await sdk.client.session.revert({
                sessionID: props.sessionID,
                messageID: message.id,
              })
              const parts = sync.data.part[message.id] ?? []
              props.setPrompt(
                parts.reduce(
                  (agg, part) => {
                    if (part.type === "text") {
                      if (!part.synthetic) agg.input += part.text
                    }
                    if (part.type === "file") agg.parts.push(part)
                    return agg
                  },
                  { input: "", parts: [] as PromptInfo["parts"] },
                ),
              )
              props.onReverted()
              dialog.clear()
            }
          : async (dialog) => {
              const forked = await sdk.client.session.fork({
                sessionID: props.sessionID,
                messageID: message.id,
              })
              const parts = sync.data.part[message.id] ?? []
              const initialPrompt = parts.reduce(
                (agg, part) => {
                  if (part.type === "text") {
                    if (!part.synthetic) agg.input += part.text
                  }
                  if (part.type === "file") agg.parts.push(part)
                  return agg
                },
                { input: "", parts: [] as PromptInfo["parts"] },
              )
              route.navigate({
                sessionID: forked.data!.id,
                type: "session",
                initialPrompt,
              })
              dialog.clear()
            },
      })
    }
    result.reverse()
    return result
  })

  return (
    <DialogSelect
      onMove={(option) => props.onMove(option.value)}
      title={mode() === "fork" ? "Fork from message" : "Revert to message"}
      options={options()}
      keybind={[
        {
          keybind: { name: "tab", ctrl: false, meta: false, shift: false, leader: false },
          title: mode() === "fork" ? "Switch to Revert" : "Switch to Fork",
          onTrigger: () => setMode((prev) => (prev === "fork" ? "revert" : "fork")),
        },
      ]}
    />
  )
}
