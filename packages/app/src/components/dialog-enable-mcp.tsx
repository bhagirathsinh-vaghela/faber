import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { createSignal } from "solid-js"
import { useLanguage } from "@/context/language"

// Confirmation for the one-way MCP enable. mcpEnabled is a latch that never
// reverts, so flipping it is an explicit, guarded action rather than a toggle.
export function DialogEnableMcp(props: { onConfirm: () => Promise<void> | void }) {
  const dialog = useDialog()
  const language = useLanguage()
  const [busy, setBusy] = createSignal(false)

  const confirm = async () => {
    if (busy()) return
    setBusy(true)
    try {
      await props.onConfirm()
      dialog.close()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title={language.t("dialog.mcp.enable.title")} class="w-full max-w-[440px] mx-auto">
      <div class="flex flex-col gap-6 p-6 pt-0">
        <p class="text-14-regular text-text-base">{language.t("dialog.mcp.enable.description")}</p>
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button type="button" variant="primary" size="large" disabled={busy()} onClick={confirm}>
            {busy() ? language.t("common.loading.ellipsis") : language.t("dialog.mcp.enable.confirm")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
