import { createMemo, onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useParams } from "@solidjs/router"
import { useLayout } from "@/context/layout"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { isStopKey, useStopSession } from "@/hooks/use-stop-session"
import { useArmSession } from "@/hooks/use-arm-session"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { getFilename } from "@opencode-ai/util/path"
import { decode64 } from "@/utils/base64"

import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Button } from "@opencode-ai/ui/button"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { Keybind } from "@opencode-ai/ui/keybind"

export function SessionHeader() {
  const layout = useLayout()
  const params = useParams()
  const command = useCommand()
  const sync = useSync()
  const language = useLanguage()
  const runStop = useStopSession()
  const runArm = useArmSession()
  const dialog = useDialog()

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

  // The keep-warm button toggles the session's persisted arm intent in place:
  // arm when cold, disarm when already warm. Reads keepWarm off the live session
  // record so both clients reflect the same state.
  function toggleWarm() {
    const id = params.id
    if (!id) return
    if (currentSession()?.keepWarm) runArm.disarm(id, projectDirectory())
    else runArm.arm(id, projectDirectory())
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
        {(mount) => (
          <Portal mount={mount()}>
            <button
              type="button"
              class="hidden @2xl/titlebar:flex w-[320px] max-w-full min-w-0 shrink any-pointer-coarse:h-10 any-pointer-coarse:[&_[data-component=icon]]:!size-6 p-1 pl-1.5 items-center gap-2 justify-between rounded-md border border-border-weak-base bg-surface-raised-base transition-colors cursor-default hover:bg-surface-raised-base-hover focus-visible:bg-surface-raised-base-hover active:bg-surface-raised-base-active"
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
              <Tooltip
                value={layout.companion.opened() ? language.t("companion.exit") : language.t("companion.enter")}
                placement="top"
                gutter={8}
              >
                <IconButton
                  icon="text-cursor-input"
                  iconSize="medium"
                  variant={layout.companion.opened() ? "primary" : "ghost"}
                  class="size-10 shrink-0 p-0"
                  onClick={() => layout.companion.toggle()}
                  aria-pressed={layout.companion.opened()}
                  aria-label={layout.companion.opened() ? language.t("companion.exit") : language.t("companion.enter")}
                />
              </Tooltip>
              <Tooltip value={language.t("session.stop")} placement="top" gutter={8}>
                <IconButton
                  icon="stop-mobile"
                  iconSize="medium"
                  variant="ghost"
                  onClick={stopSession}
                  aria-label={language.t("session.stop")}
                  class="size-10 shrink-0 [&_[data-slot=icon-svg]]:!text-icon-critical-base hover:!bg-surface-critical-weak"
                />
              </Tooltip>
            </Show>
            <Tooltip value={language.t("command.review.toggle")} placement="bottom" gutter={8}>
              <button
                type="button"
                class="group/file-tree-toggle-m flex items-center justify-center size-10 shrink-0 rounded-md leading-none [&_[data-slot=icon-svg]]:!text-icon-strong-base"
                onClick={toggleReview}
                aria-label={language.t("command.review.toggle")}
                aria-expanded={reviewActive()}
                aria-controls="review-panel"
              >
                <Icon name={reviewActive() ? "layout-right-full" : "layout-right"} size="medium" />
              </button>
            </Tooltip>
          </Portal>
        )}
      </Show>
      <Show when={rightMount()}>
        {(mount) => (
          <Portal mount={mount()}>
            <div class="flex items-center gap-3">
              <Show when={currentSession()}>
                <div class="flex items-center shrink-0 gap-1">
                  <Tooltip
                    value={
                      currentSession()?.keepWarm
                        ? language.t("session.keepWarm.armed")
                        : language.t("session.keepWarm.arm")
                    }
                    placement="top"
                    gutter={8}
                  >
                    <button
                      type="button"
                      onClick={toggleWarm}
                      aria-label={language.t("session.keepWarm.arm")}
                      aria-pressed={currentSession()?.keepWarm === true}
                      class="flex items-center justify-center size-6 any-pointer-coarse:size-10 rounded-md leading-none transition-opacity hover:bg-surface-raised-base-hover [&_[data-component=icon]]:size-4 any-pointer-coarse:[&_[data-component=icon]]:!size-6 [&_[data-component=icon]]:!text-icon-strong-base"
                      classList={{
                        "opacity-100": currentSession()?.keepWarm === true,
                        "opacity-40": !currentSession()?.keepWarm,
                      }}
                    >
                      <Icon name="sparkles" size="medium" />
                    </button>
                  </Tooltip>
                  <Tooltip
                    value={layout.companion.opened() ? language.t("companion.exit") : language.t("companion.enter")}
                    placement="top"
                    gutter={8}
                  >
                    <IconButton
                      icon="text-cursor-input"
                      iconSize="medium"
                      variant={layout.companion.opened() ? "primary" : "ghost"}
                      class="size-6 any-pointer-coarse:size-10 [&_[data-component=icon]]:size-4 any-pointer-coarse:[&_[data-component=icon]]:!size-6"
                      onClick={() => layout.companion.toggle()}
                      aria-pressed={layout.companion.opened()}
                      aria-label={
                        layout.companion.opened() ? language.t("companion.exit") : language.t("companion.enter")
                      }
                    />
                  </Tooltip>
                  <Tooltip value={language.t("session.stop")} placement="top" gutter={8}>
                    <IconButton
                      icon="stop-mobile"
                      iconSize="medium"
                      variant="ghost"
                      onClick={stopSession}
                      aria-label={language.t("session.stop")}
                      class="size-6 any-pointer-coarse:size-10 [&_[data-slot=icon-svg]]:!text-icon-critical-base [&_[data-component=icon]]:size-4 any-pointer-coarse:[&_[data-component=icon]]:!size-6 hover:!bg-surface-critical-weak"
                    />
                  </Tooltip>
                </div>
              </Show>
              <div class="flex items-center gap-3 ml-2 shrink-0">
                <TooltipKeybind
                  title={language.t("command.terminal.toggle")}
                  keybind={command.keybind("terminal.toggle")}
                >
                  <Button
                    variant="ghost"
                    class="group/terminal-toggle size-6 any-pointer-coarse:size-10 p-0 any-pointer-coarse:[&_[data-component=icon]]:!size-6"
                    onClick={() => view().terminal.toggle()}
                    aria-label={language.t("command.terminal.toggle")}
                    aria-expanded={view().terminal.opened()}
                    aria-controls="terminal-panel"
                  >
                    <div class="relative flex items-center justify-center size-4 any-pointer-coarse:size-6 [&>*]:absolute [&>*]:inset-0">
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
              <div class="block shrink-0">
                <TooltipKeybind title={language.t("command.review.toggle")} keybind={command.keybind("review.toggle")}>
                  <Button
                    variant="ghost"
                    class="group/file-tree-toggle size-6 any-pointer-coarse:size-10 p-0 any-pointer-coarse:[&_[data-component=icon]]:!size-6"
                    onClick={toggleReview}
                    aria-label={language.t("command.review.toggle")}
                    aria-expanded={reviewActive()}
                    aria-controls="review-panel"
                  >
                    <div class="relative flex items-center justify-center size-4 any-pointer-coarse:size-6 [&>*]:absolute [&>*]:inset-0">
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
            </div>
          </Portal>
        )}
      </Show>
    </>
  )
}
