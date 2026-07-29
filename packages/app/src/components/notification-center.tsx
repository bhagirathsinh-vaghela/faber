import { createMemo, createSignal, For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { DateTime } from "luxon"
import { Popover } from "@opencode-ai/ui/popover"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { base64Encode } from "@opencode-ai/util/encode"
import { getFilename } from "@opencode-ai/util/path"
import { useRecent, type OverviewRow } from "@/context/recent"
import { useLayout } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { attention, flat, strongest } from "@/utils/attention"

export function NotificationCenter(props: { mobile?: boolean }) {
  const recent = useRecent()
  const layout = useLayout()
  const language = useLanguage()
  const navigate = useNavigate()

  const [open, setOpen] = createSignal(false)

  // Busy is deliberately absent: a running turn wants nothing from the user, so
  // it would fill the list with rows there is nothing to do about.
  const state = (row: OverviewRow) =>
    attention({
      error: row.error,
      question: row.question,
      permission: row.permission,
      unseen: row.unseen,
      agent: row.agent,
    })

  const rows = createMemo(() =>
    recent
      .attention()
      .concat(recent.recent())
      .filter((row) => state(row)),
  )

  const groups = createMemo(() => {
    const byDirectory = new Map<string, OverviewRow[]>()
    for (const row of rows()) {
      const existing = byDirectory.get(row.directory)
      if (existing) {
        existing.push(row)
        continue
      }
      byDirectory.set(row.directory, [row])
    }
    return [...byDirectory.entries()]
      .map(([directory, list]) => ({ directory, rows: list.toSorted((a, b) => b.updated - a.updated) }))
      .toSorted((a, b) => (b.rows[0]?.updated ?? 0) - (a.rows[0]?.updated ?? 0))
  })

  const badge = createMemo(() => flat(strongest(rows().map(state))))

  const projectName = (directory: string) => {
    const project = layout.projects.list().find((p) => p.worktree === directory)
    if (project) return project.name || getFilename(project.worktree)
    return getFilename(directory)
  }

  const go = (row: OverviewRow) => {
    setOpen(false)
    navigate(`/${base64Encode(row.directory)}/session/${row.sessionID}`)
  }

  return (
    <Tooltip placement={props.mobile ? "bottom" : "right"} value={language.t("notification.center.title")}>
      <div class="relative">
        <Popover
          open={open()}
          onOpenChange={setOpen}
          placement={props.mobile ? "top" : "right-end"}
          title={language.t("notification.center.title")}
          class="w-[320px] max-w-[calc(100vw-40px)]"
          triggerAs={IconButton}
          triggerProps={{
            icon: "bell",
            variant: "ghost",
            size: "large",
            "aria-label": language.t("notification.center.title"),
          }}
        >
          <div class="flex flex-col gap-3 max-h-[60vh] overflow-y-auto">
            <Show
              when={groups().length > 0}
              fallback={<div class="text-14-regular text-text-weak">{language.t("notification.center.empty")}</div>}
            >
              <For each={groups()}>
                {(group) => (
                  <div class="flex flex-col gap-0.5">
                    <div class="text-11-regular text-text-weaker truncate px-1">{projectName(group.directory)}</div>
                    <For each={group.rows}>
                      {(row) => (
                        <button
                          type="button"
                          class="flex items-center gap-2 w-full text-left px-1 py-1 rounded-md hover:bg-surface-raised-base-hover"
                          onClick={() => go(row)}
                        >
                          <Show when={flat(state(row))}>
                            {(dot) => (
                              <div
                                title={language.t(dot().label)}
                                class={`shrink-0 size-1.5 rounded-full ${dot().class}`}
                                style={dot().tint ? { "background-color": dot().tint } : undefined}
                              />
                            )}
                          </Show>
                          <span class="text-14-regular text-text-strong truncate grow min-w-0">
                            {row.title || language.t("notification.center.untitledSession")}
                          </span>
                          <span class="shrink-0 text-11-regular text-text-weaker">
                            {DateTime.fromMillis(row.updated).setLocale(language.locale()).toRelative()}
                          </span>
                        </button>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </Popover>
        <Show when={badge()}>
          {(dot) => (
            <div
              class={`absolute top-0.5 right-0.5 size-1.5 rounded-full pointer-events-none ${dot().class}`}
              style={dot().tint ? { "background-color": dot().tint } : undefined}
            />
          )}
        </Show>
      </div>
    </Tooltip>
  )
}
