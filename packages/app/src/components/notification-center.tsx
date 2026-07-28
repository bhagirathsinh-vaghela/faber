import { createMemo, createSignal, For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { DateTime } from "luxon"
import { Popover } from "@opencode-ai/ui/popover"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { base64Encode } from "@opencode-ai/util/encode"
import { getFilename } from "@opencode-ai/util/path"
import { Binary } from "@opencode-ai/util/binary"
import { useNotification, type Notification } from "@/context/notification"
import { useGlobalSync } from "@/context/global-sync"
import { useLayout } from "@/context/layout"
import { useLanguage } from "@/context/language"

// A session.error event can carry no sessionID; the store persists this
// sentinel in its place, so it is never a routable session.
const GLOBAL_SESSION = "global"

// Persisted records predate the current error union, so every level is
// probed at runtime rather than trusted from the declared type.
function errorText(notification: Notification) {
  if (notification.type !== "error") return undefined
  const error: unknown = notification.error
  if (!error) return undefined
  if (typeof error === "string") return error
  if (typeof error !== "object") return undefined
  const data = (error as { data?: unknown }).data
  if (!data || typeof data !== "object") return undefined
  const message = (data as { message?: unknown }).message
  if (typeof message !== "string") return undefined
  return message
}

export function NotificationCenter(props: { mobile?: boolean }) {
  const notification = useNotification()
  const globalSync = useGlobalSync()
  const layout = useLayout()
  const language = useLanguage()
  const navigate = useNavigate()

  const [open, setOpen] = createSignal(false)

  const unseen = createMemo(() => notification.unseen().filter((n) => n.directory))
  const hasError = createMemo(() => unseen().some((n) => n.type === "error"))

  const groups = createMemo(() => {
    const byDirectory = new Map<string, Notification[]>()
    for (const entry of unseen()) {
      const directory = entry.directory
      if (!directory) continue
      const existing = byDirectory.get(directory)
      if (existing) {
        existing.push(entry)
        continue
      }
      byDirectory.set(directory, [entry])
    }
    return [...byDirectory.entries()]
      .map(([directory, entries]) => ({
        directory,
        entries: entries.toSorted((a, b) => b.time - a.time),
      }))
      .toSorted((a, b) => (b.entries[0]?.time ?? 0) - (a.entries[0]?.time ?? 0))
  })

  const projectName = (directory: string) => {
    const project = layout.projects.list().find((p) => p.worktree === directory)
    if (project) return project.name || getFilename(project.worktree)
    return getFilename(directory)
  }

  const sessionTitle = (directory: string, id: string | undefined) => {
    if (!id || id === GLOBAL_SESSION) return language.t("notification.center.untitledSession")
    const [store] = globalSync.child(directory, { bootstrap: false })
    const match = Binary.search(store.session, id, (s) => s.id)
    if (!match.found) return id
    return store.session[match.index]?.title || id
  }

  const go = (entry: Notification) => {
    const directory = entry.directory
    if (!directory) return
    setOpen(false)
    const session = entry.session
    if (!session || session === GLOBAL_SESSION) {
      navigate(`/${base64Encode(directory)}`)
      return
    }
    // Navigating to the session already routed is a no-op, so the route-change
    // effect that normally clears the entry never fires.
    notification.session.markViewed(session)
    navigate(`/${base64Encode(directory)}/session/${session}`)
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
                    <For each={group.entries}>
                      {(entry) => (
                        <button
                          type="button"
                          class="flex items-start gap-2 w-full text-left px-1 py-1 rounded-md hover:bg-surface-raised-base-hover"
                          onClick={() => go(entry)}
                        >
                          <div
                            classList={{
                              "shrink-0 size-1.5 rounded-full mt-[7px]": true,
                              "bg-icon-critical-base": entry.type === "error",
                              "bg-text-interactive-base": entry.type !== "error",
                            }}
                          />
                          <div class="flex flex-col min-w-0 grow">
                            <span class="text-14-regular text-text-strong truncate">
                              {sessionTitle(group.directory, entry.session)}
                            </span>
                            <Show when={errorText(entry)}>
                              {(text) => <span class="text-12-regular text-text-weak truncate">{text()}</span>}
                            </Show>
                          </div>
                          <span class="shrink-0 text-11-regular text-text-weaker mt-0.5">
                            {DateTime.fromMillis(entry.time).setLocale(language.locale()).toRelative()}
                          </span>
                        </button>
                      )}
                    </For>
                  </div>
                )}
              </For>
              <Button variant="ghost" size="small" class="self-start" onClick={() => notification.markAllViewed()}>
                {language.t("notification.center.markAllRead")}
              </Button>
            </Show>
          </div>
        </Popover>
        <Show when={unseen().length > 0}>
          <div
            classList={{
              "absolute top-0.5 right-0.5 size-1.5 rounded-full pointer-events-none": true,
              "bg-icon-critical-base": hasError(),
              "bg-text-interactive-base": !hasError(),
            }}
          />
        </Show>
      </div>
    </Tooltip>
  )
}
