import { Button } from "@opencode-ai/ui/button"
import { Logo } from "@opencode-ai/ui/logo"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogSelectServer } from "@/components/dialog-select-server"
import { Overview } from "@/components/dialog-overview"
import { useServer } from "@/context/server"

export default function Home() {
  const dialog = useDialog()
  const server = useServer()

  return (
    <div class="mx-auto mt-55 w-full md:w-auto px-4">
      <Logo class="md:w-xl opacity-12" />
      <Button
        size="large"
        variant="ghost"
        class="mt-4 mx-auto text-14-regular text-text-weak"
        onClick={() => dialog.show(() => <DialogSelectServer />)}
      >
        <div
          classList={{
            "size-2 rounded-full": true,
            "bg-icon-success-base": server.healthy() === true,
            "bg-icon-critical-base": server.healthy() === false,
            "bg-border-weak-base": server.healthy() === undefined,
          }}
        />
        {server.name}
      </Button>
      <div class="mt-20" />
      <Overview />
    </div>
  )
}
