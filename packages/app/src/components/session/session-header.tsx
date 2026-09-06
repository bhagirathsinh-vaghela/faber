import { createMemo, onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useParams } from "@solidjs/router"
import { useLayout } from "@/context/layout"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { useLocal } from "@/context/local"
import { isStopKey, useStopSession } from "@/hooks/use-stop-session"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { getFilename } from "@opencode-ai/util/path"
import { decode64 } from "@/utils/base64"

import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Button } from "@opencode-ai/ui/button"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { Keybind } from "@opencode-ai/ui/keybind"
import { JobsButton } from "@/components/jobs-button"
import { SubagentsButton } from "@/components/subagents-button"

export function SessionHeader() {
  const layout = useLayout()
  const params = useParams()
  const command = useCommand()
  const sync = useSync()
  const language = useLanguage()
  const runStop = useStopSession()
  const dialog = useDialog()
  const local = useLocal()

  const projectDirectory = createMemo(() => decode64(params.dir) ?? "")
  const project = createMemo(() => {
    const directory = projectDirectory()
    if (!directory) return
    return layout.projects.list().find((p) => p.worktree === directory)
  })
  const name = createMemo(() => {
    const current = project()
    if (current) return current.name || getFilename(current.worktree)
    return getFilename(projectDirectory())
  })
  const hotkey = createMemo(() => command.keybind("file.open"))

  const currentSession = createMemo(() => sync.data.session.find((s) => s.id === params.id))
  const sessionKey = createMemo(() => `${params.dir}${params.id ? "/" + params.id : ""}`)
  const view = createMemo(() => layout.view(sessionKey))

  // One intent, two presentations: with room the review opens beside the
  // transcript, without it the panel replaces it. The toggle records only that
  // review is wanted; the layout decides how that looks.
  const toggleReview = () => layout.fileTree.toggle()
  const reviewActive = () => layout.fileTree.opened()

  function stopSession() {
    const id = params.id
    if (!id) return
    runStop(id, projectDirectory())
  }

  // The stop keys stop the open session, matching the header stop button and
  // the overview's.
  const stop = (event: KeyboardEvent) => {
    if (!isStopKey(event)) return
    if (!params.id) return
    // A dialog (e.g. the overview) open on top of the session owns the stop
    // keys — it stops its highlighted row. Both this handler and the overview's
    // are window/capture-phase listeners, so stopPropagation can't stop the
    // other, and this one is registered first (the session mounts before the
    // dialog). Bail while a dialog is active so the key hits only the row.
    if (dialog.active) return
    event.preventDefault()
    event.stopPropagation()
    stopSession()
  }
  onMount(() => window.addEventListener("keydown", stop, true))
  onCleanup(() => window.removeEventListener("keydown", stop, true))

  const centerMount = createMemo(() => document.getElementById("opencode-titlebar-center"))
  const rightMount = createMemo(() => document.getElementById("opencode-titlebar-right"))
  const mobileMount = createMemo(() => document.getElementById("opencode-titlebar-mobile"))

  return (
    <>
      <Show when={centerMount()}>
        {/* Solid's Portal always wraps its children in a div, which shrink-wraps
            to the button's fixed width; max-w-full would then resolve against
            that wrapper and the box could never give room back to the controls
            beside it. display:contents takes the wrapper out of layout. */}
        {(mount) => (
          <Portal mount={mount()} ref={(el) => (el.style.display = "contents")}>
            <button
              type="button"
              class="hidden @2xl/titlebar:flex w-[320px] max-w-full min-w-0 shrink h-(--control-height) p-1 pl-1.5 items-center gap-2 justify-between rounded-md border border-border-weak-base bg-surface-raised-base transition-colors cursor-default hover:bg-surface-raised-base-hover focus-visible:bg-surface-raised-base-hover active:bg-surface-raised-base-active"
              onClick={() => command.trigger("file.open")}
              aria-label={language.t("session.header.searchFiles")}
            >
              <div class="flex min-w-0 flex-1 items-center gap-2 overflow-visible">
                <Icon name="magnifying-glass" size="normal" class="icon-base shrink-0" />
                <span class="flex-1 min-w-0 text-14-regular text-text-weak truncate h-4.5 flex items-center">
                  {language.t("session.header.search.placeholder", { project: name() })}
                </span>
              </div>

              <Show when={hotkey()}>{(keybind) => <Keybind class="shrink-0">{keybind()}</Keybind>}</Show>
            </button>
          </Portal>
        )}
      </Show>
      {/* Mobile: the controls portal into the titlebar's flat flex row. Solid's
          Portal always wraps its children in a div (event delegation), so we set
          that wrapper to display:contents via ref — the controls then become
          direct flex siblings of Home/Menu and justify-between spreads them all
          evenly across the width. */}
      <Show when={mobileMount()}>
        {(mount) => (
          <Portal mount={mount()} ref={(el) => (el.style.display = "contents")}>
            {/* Search + server indicator now live in the shared Titlebar so
                they show on every route. Only the session-scoped controls
                portal here. */}
            <Show when={currentSession()}>
              {/* Companion toggle sits immediately left of Stop. It lives here
                  rather than in the shared Titlebar so it can be ordered among
                  the session-scoped controls, which all portal into this mount. */}
              <Show when={local.dock.isVisibleOn("mobile", "companion")}>
                <Tooltip
                  value={layout.companion.opened() ? language.t("companion.exit") : language.t("companion.enter")}
                  placement="top"
                  gutter={8}
                >
                  <IconButton
                    icon="text-cursor-input"
                    iconSize="medium"
                    variant={layout.companion.opened() ? "primary" : "ghost"}
                    class="shrink-0 p-0"
                    onClick={() => layout.companion.toggle()}
                    aria-pressed={layout.companion.opened()}
                    aria-label={
                      layout.companion.opened() ? language.t("companion.exit") : language.t("companion.enter")
                    }
                  />
                </Tooltip>
              </Show>
              <Tooltip value={language.t("common.jobs")} placement="top" gutter={8}>
                <JobsButton />
              </Tooltip>
              <Tooltip value={language.t("command.task.list")} placement="top" gutter={8}>
                <SubagentsButton />
              </Tooltip>
              <Tooltip value={language.t("session.stop")} placement="top" gutter={8}>
                <IconButton
                  icon="circle-ban-sign"
                  iconSize="medium"
                  variant="ghost"
                  onClick={stopSession}
                  aria-label={language.t("session.stop")}
                  class="shrink-0 [&_[data-slot=icon-svg]]:!text-icon-critical-base [&_[data-slot=icon-svg]]:[stroke-width:1.5] hover:!bg-surface-critical-weak"
                />
              </Tooltip>
            </Show>
            <Show when={local.dock.isVisibleOn("mobile", "review")}>
              <Tooltip value={language.t("command.review.toggle")} placement="bottom" gutter={8}>
                <button
                  type="button"
                  class="group/file-tree-toggle-m flex items-center justify-center size-(--control-height) shrink-0 rounded-md leading-none [&_[data-slot=icon-svg]]:!text-icon-strong-base"
                  onClick={toggleReview}
                  aria-label={language.t("command.review.toggle")}
                  aria-expanded={reviewActive()}
                  aria-controls="review-panel"
                >
                  <Icon name={reviewActive() ? "layout-right-full" : "layout-right"} size="medium" />
                </button>
              </Tooltip>
            </Show>
          </Portal>
        )}
      </Show>
      <Show when={rightMount()}>
        {(mount) => (
          <Portal mount={mount()}>
            <div class="flex items-center gap-3">
              <Show when={currentSession()}>
                <div class="flex items-center shrink-0 gap-1">
                  <Show when={local.dock.isVisibleOn("desktop", "companion")}>
                    <Tooltip
                      value={layout.companion.opened() ? language.t("companion.exit") : language.t("companion.enter")}
                      placement="top"
                      gutter={8}
                    >
                      <IconButton
                        icon="text-cursor-input"
                        iconSize="medium"
                        variant={layout.companion.opened() ? "primary" : "ghost"}
                        class=""
                        onClick={() => layout.companion.toggle()}
                        aria-pressed={layout.companion.opened()}
                        aria-label={
                          layout.companion.opened() ? language.t("companion.exit") : language.t("companion.enter")
                        }
                      />
                    </Tooltip>
                  </Show>
                  <Tooltip value={language.t("common.jobs")} placement="top" gutter={8}>
                    <JobsButton />
                  </Tooltip>
                  <Tooltip value={language.t("command.task.list")} placement="top" gutter={8}>
                    <SubagentsButton />
                  </Tooltip>
                  <Tooltip value={language.t("session.stop")} placement="top" gutter={8}>
                    <IconButton
                      icon="circle-ban-sign"
                      iconSize="medium"
                      variant="ghost"
                      onClick={stopSession}
                      aria-label={language.t("session.stop")}
                      class="[&_[data-slot=icon-svg]]:!text-icon-critical-base [&_[data-slot=icon-svg]]:[stroke-width:1.5] hover:!bg-surface-critical-weak"
                    />
                  </Tooltip>
                </div>
              </Show>
              <Show when={local.dock.isVisibleOn("desktop", "terminal")}>
                <div class="flex items-center gap-3 ml-2 shrink-0">
                  <TooltipKeybind
                    title={language.t("command.terminal.toggle")}
                    keybind={command.keybind("terminal.toggle")}
                  >
                    <Button
                      variant="ghost"
                      class="group/terminal-toggle p-0"
                      onClick={() => view().terminal.toggle()}
                      aria-label={language.t("command.terminal.toggle")}
                      aria-expanded={view().terminal.opened()}
                      aria-controls="terminal-panel"
                    >
                      <div class="relative flex items-center justify-center [&>*]:absolute [&>*]:inset-0">
                        <Icon
                          size="small"
                          name={view().terminal.opened() ? "layout-bottom-full" : "layout-bottom"}
                          class="group-hover/terminal-toggle:hidden"
                        />
                        <Icon
                          size="small"
                          name="layout-bottom-partial"
                          class="hidden group-hover/terminal-toggle:inline-block"
                        />
                        <Icon
                          size="small"
                          name={view().terminal.opened() ? "layout-bottom" : "layout-bottom-full"}
                          class="hidden group-active/terminal-toggle:inline-block"
                        />
                      </div>
                    </Button>
                  </TooltipKeybind>
                </div>
              </Show>
              <Show when={local.dock.isVisibleOn("desktop", "review")}>
                <div class="block shrink-0">
                  <TooltipKeybind
                    title={language.t("command.review.toggle")}
                    keybind={command.keybind("review.toggle")}
                  >
                    <Button
                      variant="ghost"
                      class="group/file-tree-toggle p-0"
                      onClick={toggleReview}
                      aria-label={language.t("command.review.toggle")}
                      aria-expanded={reviewActive()}
                      aria-controls="review-panel"
                    >
                      <div class="relative flex items-center justify-center [&>*]:absolute [&>*]:inset-0">
                        <Icon
                          size="small"
                          name={reviewActive() ? "layout-right-full" : "layout-right"}
                          class="group-hover/file-tree-toggle:hidden"
                        />
                        <Icon
                          size="small"
                          name="layout-right-partial"
                          class="hidden group-hover/file-tree-toggle:inline-block"
                        />
                        <Icon
                          size="small"
                          name={reviewActive() ? "layout-right" : "layout-right-full"}
                          class="hidden group-active/file-tree-toggle:inline-block"
                        />
                      </div>
                    </Button>
                  </TooltipKeybind>
                </div>
              </Show>
            </div>
          </Portal>
        )}
      </Show>
    </>
  )
}
