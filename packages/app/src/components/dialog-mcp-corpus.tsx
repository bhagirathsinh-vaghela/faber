import { createResource, For, Show } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"

// Read-only view of the MCP tools the model sees for THIS session's instance:
// every connected server's advertised tools minus its `disabled` config, each at
// the server's catalog tier. Fetched from GET /mcp/corpus through the
// per-directory SDK client, so it reflects this instance's global+project
// servers. Management (add/remove servers, disable tools) is config-file only;
// this dialog only shows what the model currently has.
export function DialogMcpCorpus() {
  const sdk = useSDK()
  const language = useLanguage()
  const t = language.t

  const [corpus] = createResource(async () => {
    const result = await sdk.client.mcp.corpus()
    return result.data ?? []
  })

  return (
    <Dialog title={t("dialog.mcp.corpus.title")} class="w-full max-w-[520px] mx-auto">
      <div class="flex flex-col gap-4 p-6 pt-0 max-h-[60vh] overflow-y-auto no-scrollbar">
        <Show
          when={!corpus.loading}
          fallback={<p class="text-14-regular text-text-weak">{t("common.loading.ellipsis")}</p>}
        >
          <Show
            when={(corpus()?.length ?? 0) > 0}
            fallback={<p class="text-14-regular text-text-weak">{t("dialog.mcp.corpus.empty")}</p>}
          >
            <For each={corpus()}>
              {(group) => (
                <div class="flex flex-col gap-2">
                  <div class="flex items-baseline justify-between gap-3">
                    <span class="text-14-medium text-text-strong">{group.server}</span>
                    <span class="text-11-regular text-text-weaker">{t(`dialog.mcp.corpus.tier.${group.tier}`)}</span>
                  </div>
                  <div class="flex flex-col gap-1 pl-1">
                    <For each={group.tools}>
                      {(tool) => (
                        <div class="flex flex-col">
                          <span class="text-12-medium text-text-base">{tool.key}</span>
                          <Show when={tool.description}>
                            <span class="text-11-regular text-text-weaker line-clamp-2">{tool.description}</span>
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </Dialog>
  )
}
