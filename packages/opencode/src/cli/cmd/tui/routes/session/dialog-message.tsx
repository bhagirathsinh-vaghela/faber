import { createMemo } from "solid-js"
import { useSync } from "@tui/context/sync"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { Clipboard } from "@tui/util/clipboard"
import type { PromptInfo } from "@tui/component/prompt/history"
import { useLocal } from "@tui/context/local"
import { Identifier } from "@/id/id"
import { useToast } from "../../ui/toast"

function waitForIdle(sync: ReturnType<typeof useSync>, sessionID: string, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = setTimeout(() => resolve(false), timeout)
    const poll = setInterval(() => {
      const status = sync.data.session_status?.[sessionID]
      if (!status || status.type === "idle") {
        clearTimeout(deadline)
        clearInterval(poll)
        resolve(true)
      }
    }, 200)
  })
}

export function DialogMessage(props: {
  messageID: string
  sessionID: string
  setPrompt?: (prompt: PromptInfo) => void
}) {
  const sync = useSync()
  const sdk = useSDK()
  const local = useLocal()
  const toast = useToast()
  const message = createMemo(() => sync.data.message[props.sessionID]?.find((x) => x.id === props.messageID))
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])
  const route = useRoute()

  const prevAssistant = createMemo(() => messages().findLast((m) => m.id < props.messageID && m.role === "assistant"))

  const options = createMemo(() => {
    const result = []

    if (prevAssistant()) {
      result.push({
        title: "Revert here",
        value: "session.continue_from",
        description: "(cache-safe revert)",
        onSelect: async (dialog: any) => {
          const assistant = prevAssistant()
          if (!assistant) return

          dialog.clear()

          await sdk.client.session.unrevert({ sessionID: props.sessionID })

          await sdk.client.session.update({
            sessionID: props.sessionID,
            cacheProbeMessageID: assistant.id,
          })

          const selectedModel = local.model.current()
          if (!selectedModel) return

          await sdk.client.session.prompt({
            sessionID: props.sessionID,
            messageID: Identifier.ascending("message"),
            agent: local.agent.current().name,
            model: {
              providerID: selectedModel.providerID,
              modelID: selectedModel.modelID,
            },
            variant: local.model.variant.current(),
            parts: [{ id: Identifier.ascending("part"), type: "text", text: "." }],
          })

          const idle = await waitForIdle(sync, props.sessionID, 10_000)
          if (!idle) {
            toast.show({ message: "Session busy — revert abandoned", variant: "error", duration: 3000 })
            return
          }

          await sdk.client.session.revert({
            sessionID: props.sessionID,
            messageID: props.messageID,
          })

          if (props.setPrompt) {
            const parts = sync.data.part[props.messageID]
            if (parts) {
              props.setPrompt(
                parts.reduce(
                  (agg, part) => {
                    if (part.type === "text" && !part.synthetic) agg.input += part.text
                    if (part.type === "file") agg.parts.push(part)
                    return agg
                  },
                  { input: "", parts: [] as PromptInfo["parts"] },
                ),
              )
            }
          }

          toast.show({ message: "Reverted — cache preserved", variant: "success", duration: 2000 })
        },
      })
    }

    result.push({
      title: "Revert",
      value: "session.revert",
      description: "undo messages and file changes",
      onSelect: (dialog: any) => {
        const msg = message()
        if (!msg) return

        sdk.client.session.revert({
          sessionID: props.sessionID,
          messageID: msg.id,
        })

        if (props.setPrompt) {
          const parts = sync.data.part[msg.id]
          const promptInfo = parts.reduce(
            (agg, part) => {
              if (part.type === "text") {
                if (!part.synthetic) agg.input += part.text
              }
              if (part.type === "file") agg.parts.push(part)
              return agg
            },
            { input: "", parts: [] as PromptInfo["parts"] },
          )
          props.setPrompt(promptInfo)
        }

        dialog.clear()
      },
    })

    result.push({
      title: "Copy",
      value: "message.copy",
      description: "message text to clipboard",
      onSelect: async (dialog: any) => {
        const msg = message()
        if (!msg) return

        const parts = sync.data.part[msg.id]
        const text = parts.reduce((agg, part) => {
          if (part.type === "text" && !part.synthetic) {
            agg += part.text
          }
          return agg
        }, "")

        await Clipboard.copy(text)
        dialog.clear()
      },
    })

    result.push({
      title: "Fork",
      value: "session.fork",
      description: "create a new session",
      onSelect: async (dialog: any) => {
        const result = await sdk.client.session.fork({
          sessionID: props.sessionID,
          messageID: props.messageID,
        })
        const initialPrompt = (() => {
          const msg = message()
          if (!msg) return undefined
          const parts = sync.data.part[msg.id]
          return parts.reduce(
            (agg, part) => {
              if (part.type === "text") {
                if (!part.synthetic) agg.input += part.text
              }
              if (part.type === "file") agg.parts.push(part)
              return agg
            },
            { input: "", parts: [] as PromptInfo["parts"] },
          )
        })()
        route.navigate({
          sessionID: result.data!.id,
          type: "session",
          initialPrompt,
        })
        dialog.clear()
      },
    })

    return result
  })

  return <DialogSelect title="Message Actions" options={options()} />
}
