import { Component, For, Show } from "solid-js"
import { Switch } from "@opencode-ai/ui/switch"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { Button } from "@opencode-ai/ui/button"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"

// Collapsible transcript box types that have a body (header-only tools like
// webfetch/skill are omitted — nothing to collapse). Label is shown as-is; the
// key matches the tool name used at the render site.
const BOX_TYPES: { key: string; label: string }[] = [
  { key: "user", label: "User message" },
  { key: "task_result", label: "Task result" },
  { key: "task", label: "Task" },
  { key: "bash", label: "Bash" },
  { key: "edit", label: "Edit" },
  { key: "write", label: "Write" },
  { key: "apply_patch", label: "Apply patch" },
  { key: "read", label: "Read" },
  { key: "list", label: "List" },
  { key: "glob", label: "Glob" },
  { key: "grep", label: "Grep" },
  { key: "websearch", label: "Web search" },
  { key: "todowrite", label: "Todo write" },
  { key: "question", label: "Question" },
  { key: "mcp", label: "MCP & other tools" },
]

export const SettingsLayout: Component = () => {
  const language = useLanguage()
  const settings = useSettings()

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 wide:px-10 wide:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-raised-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.tab.layout")}</h2>
        </div>
      </div>

      <div class="flex flex-col gap-8 w-full">
        {/* Box collapse defaults Section */}
        <div class="flex flex-col gap-1">
          <div class="flex items-center justify-between pb-2">
            <h3 class="text-14-medium text-text-strong">
              {language.t("settings.layout.section.boxes")}
              <Show when={settings.boxes.dirty()}>
                <span class="text-text-warning-base"> •</span>
              </Show>
            </h3>
            <div class="flex items-center gap-2">
              <Button
                variant="secondary"
                size="small"
                disabled={!settings.boxes.dirty()}
                onClick={() => settings.boxes.discard()}
              >
                {language.t("settings.customization.discard")}
              </Button>
              <Button
                variant="primary"
                size="small"
                disabled={!settings.boxes.dirty()}
                onClick={() => settings.boxes.save()}
              >
                {language.t("settings.customization.save")}
              </Button>
            </div>
          </div>
          <p class="text-12-regular text-text-weak pb-2">{language.t("settings.layout.boxes.description")}</p>

          <div class="box-matrix bg-surface-raised-base px-4 rounded-lg max-w-[720px]">
            <div class="grid grid-cols-[1fr_4rem_4rem] items-center py-2 border-b border-border-weak-base text-11-medium text-text-weak">
              <span />
              <span class="text-center">{language.t("settings.layout.boxes.normal")}</span>
              <span class="text-center">{language.t("settings.layout.boxes.reader")}</span>
            </div>
            <For each={BOX_TYPES}>
              {(box) => (
                <div class="grid grid-cols-[1fr_4rem_4rem] items-center py-3 border-b border-border-weak-base last:border-none">
                  <span class="text-14-medium text-text-strong truncate">{box.label}</span>
                  <div class="flex justify-center" data-action={`settings-box-${box.key}-normal`}>
                    <Checkbox
                      checked={settings.boxes.draft(box.key, "normal")}
                      onChange={(checked) => settings.boxes.setCollapsed(box.key, "normal", checked)}
                    />
                  </div>
                  <div class="flex justify-center" data-action={`settings-box-${box.key}-reader`}>
                    <Checkbox
                      checked={settings.boxes.draft(box.key, "reader")}
                      onChange={(checked) => settings.boxes.setCollapsed(box.key, "reader", checked)}
                    />
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>
    </div>
  )
}
