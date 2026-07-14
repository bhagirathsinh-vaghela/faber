import { createSignal, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { createDictation } from "@/utils/dictation"
import { DictationOverlay } from "@/components/dictation-overlay"

// A mic-only page for a phone or other mic-equipped device. It dictates into the
// server-side pool; a composer on any other device pulls the transcript in. No
// session, no composer — the only difference from normal dictation is that
// accepted text is appended to the pool instead of an editor.
export default function Companion() {
  const sdk = useGlobalSDK()
  const language = useLanguage()
  const [dictating, setDictating] = createSignal(false)

  const dictation = createDictation({
    url: () => sdk.url,
    onError: (message) => {
      setDictating(false)
      showToast({ title: language.t("prompt.toast.dictationFailed.title"), description: message })
    },
  })

  const send = (text: string) => {
    sdk.client.dictation.pool.append({ text }).catch((err) => {
      showToast({
        title: language.t("companion.toast.sendFailed.title"),
        description: err instanceof Error ? err.message : String(err),
      })
    })
    showToast({ title: language.t("companion.toast.sent.title"), duration: 2000 })
  }

  return (
    <div class="size-full flex flex-col items-center justify-center gap-6 p-6 text-center bg-background-stronger">
      <div class="flex flex-col items-center gap-2">
        <h1 class="text-16-medium text-text-strong">{language.t("companion.title")}</h1>
        <p class="text-13-regular text-text-weak max-w-xs">{language.t("companion.hint")}</p>
      </div>
      <Show
        when={dictation.supported()}
        fallback={<p class="text-13-regular text-text-weak">{language.t("companion.unsupported")}</p>}
      >
        <Button
          type="button"
          variant="primary"
          class="size-16 rounded-full"
          onClick={() => {
            setDictating(true)
            dictation.start()
          }}
          aria-label={language.t("prompt.action.dictate")}
        >
          <Icon name="mic" class="size-7" />
        </Button>
      </Show>
      <Show when={dictating()}>
        <DictationOverlay dictation={dictation} onAccept={send} onStash={send} onClose={() => setDictating(false)} />
      </Show>
    </div>
  )
}
