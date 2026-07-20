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
    <Dialog
      title={t("dialog.mcp.corpus.title")}
      description={t("dialog.mcp.corpus.subtitle")}
      class="w-full max-w-[560px] mx-auto"
    >
      <div class="flex flex-col gap-6 p-6 pt-2 max-h-[60vh] overflow-y-auto no-scrollbar">
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
                  {/* Server header: name + tool count, and what the MODEL gets
                      at this server's tier (the viewer always shows more). */}
                  <div class="flex items-baseline justify-between gap-3 pb-1 border-b border-border-weak-base">
                    <div class="flex items-baseline gap-2 min-w-0">
                      <span class="text-14-medium text-text-strong truncate">{group.server}</span>
                      <span class="text-11-regular text-text-weaker shrink-0">
                        {t("dialog.mcp.corpus.server.count", { count: group.tools.length })}
                      </span>
                    </div>
                    <span class="text-11-regular text-text-weaker shrink-0">{t(`dialog.mcp.corpus.model.${group.tier}`)}</span>
                  </div>
                  <div class="flex flex-col gap-2.5">
                    <For each={group.tools}>
                      {(tool) => (
                        <div class="flex flex-col gap-0.5">
                          <span class="text-13-medium text-text-base font-mono">{tool.key}</span>
                          <Show when={tool.description}>
                            <span class="text-12-regular text-text-weak">{tool.description}</span>
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
