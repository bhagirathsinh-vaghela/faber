import { Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogSelectServer } from "@/components/dialog-select-server"
import { Overview } from "@/components/dialog-overview"
import { useServer } from "@/context/server"

export default function Home() {
  const dialog = useDialog()
  const server = useServer()

  return (
    <div class="size-full min-h-0 flex flex-col items-center overflow-hidden px-4 bg-background-stronger">
      <div class="shrink-0 flex flex-col items-center mt-8 mb-6">
        <Button
          size="large"
          variant="ghost"
          class="text-14-regular text-text-weak"
          onClick={() => dialog.show(() => <DialogSelectServer />)}
        >
          <div
            classList={{
              "size-2 rounded-full": true,
              "bg-icon-success-base": server.status() === "live",
              "bg-icon-warning-base": server.status() === "stale",
              "bg-icon-critical-base": server.status() === "down",
              "bg-border-weak-base": server.status() === undefined,
            }}
          />
          {server.machine}
          <Show when={server.machine !== server.name}>
            <span class="text-text-weaker">({server.name})</span>
          </Show>
        </Button>
      </div>
      <div class="flex-1 min-h-0 w-full max-w-2xl flex flex-col">
        <Overview attention />
      </div>
    </div>
  )
}
