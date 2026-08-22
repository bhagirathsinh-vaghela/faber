import { createEffect, createMemo, createSignal, onCleanup, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocation, useNavigate } from "@solidjs/router"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { useTheme } from "@opencode-ai/ui/theme"
import { useDialog } from "@opencode-ai/ui/context/dialog"

import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { StatusPopover } from "@/components/status-popover"
import { createStandalone, useShell } from "@/utils/mobile"

export function Titlebar() {
  const layout = useLayout()
  const platform = usePlatform()
  const command = useCommand()
  const language = useLanguage()
  const theme = useTheme()
  const dialog = useDialog()
  const navigate = useNavigate()
  const location = useLocation()

  const goHome = () => {
    if (dialog.active) dialog.close()
    navigate("/")
  }

  // Installed PWA has no browser chrome, so no address-bar reload. Surface a
  // reload button in the mobile row only in that mode; a normal tab already has
  // the browser's own reload.
  const standalone = createStandalone()

  // Labelled and iconed with the layout it switches TO, so the glyph reads as a
  // destination rather than a status. Lives in the shared titlebar rather than a
  // session portal so it stays reachable in every layout it can switch between.
  const shell = useShell()
  const surfaceLabel = () =>
    shell.forced()
      ? language.t("surface.toggle.auto")
      : shell.compact()
        ? language.t("surface.toggle.desktop")
        : language.t("surface.toggle.mobile")

  const mac = createMemo(() => platform.platform === "desktop" && platform.os === "macos")
  const windows = createMemo(() => platform.platform === "desktop" && platform.os === "windows")
  const zoom = () => platform.webviewZoom?.() ?? 1
  const minHeight = () => (mac() ? `${40 / zoom()}px` : undefined)

  // In an installed browser PWA the window-controls-overlay hands the native
  // title strip to the app. Track its visibility so we paint into that strip
  // instead of leaving Chrome's opaque title bar above our content.
  const wcoApi = (
    navigator as unknown as {
      windowControlsOverlay?: {
        visible: boolean
        addEventListener(type: "geometrychange", cb: () => void): void
        removeEventListener(type: "geometrychange", cb: () => void): void
      }
    }
  ).windowControlsOverlay
  const [overlay, setOverlay] = createSignal(wcoApi?.visible ?? false)
  if (wcoApi) {
    const onGeometry = () => setOverlay(wcoApi.visible)
    wcoApi.addEventListener("geometrychange", onGeometry)
    onCleanup(() => wcoApi.removeEventListener("geometrychange", onGeometry))
  }

  const [history, setHistory] = createStore({
    stack: [] as string[],
    index: 0,
    action: undefined as "back" | "forward" | undefined,
  })

  const path = () => `${location.pathname}${location.search}${location.hash}`

  createEffect(() => {
    const current = path()

    untrack(() => {
      if (!history.stack.length) {
        const stack = current === "/" ? ["/"] : ["/", current]
        setHistory({ stack, index: stack.length - 1 })
        return
      }

      const active = history.stack[history.index]
      if (current === active) {
        if (history.action) setHistory("action", undefined)
        return
      }

      if (history.action) {
        setHistory("action", undefined)
        return
      }

      const next = history.stack.slice(0, history.index + 1).concat(current)
      setHistory({ stack: next, index: next.length - 1 })
    })
  })

  const canBack = createMemo(() => history.index > 0)
  const canForward = createMemo(() => history.index < history.stack.length - 1)

  const back = () => {
    if (!canBack()) return
    const index = history.index - 1
    const to = history.stack[index]
    if (!to) return
    setHistory({ index, action: "back" })
    navigate(to)
  }

  const forward = () => {
    if (!canForward()) return
    const index = history.index + 1
    const to = history.stack[index]
    if (!to) return
    setHistory({ index, action: "forward" })
    navigate(to)
  }

  const getWin = () => {
    if (platform.platform !== "desktop") return

    const tauri = (
      window as unknown as {
        __TAURI__?: { window?: { getCurrentWindow?: () => { startDragging?: () => Promise<void> } } }
      }
    ).__TAURI__
    if (!tauri?.window?.getCurrentWindow) return

    return tauri.window.getCurrentWindow()
  }

  createEffect(() => {
    if (platform.platform !== "desktop") return

    const scheme = theme.colorScheme()
    const value = scheme === "system" ? null : scheme

    const tauri = (window as unknown as { __TAURI__?: { webviewWindow?: { getCurrentWebviewWindow?: () => unknown } } })
      .__TAURI__
    const get = tauri?.webviewWindow?.getCurrentWebviewWindow
    if (!get) return

    const win = get() as { setTheme?: (theme?: "light" | "dark" | null) => Promise<void> }
    if (!win.setTheme) return

    void win.setTheme(value).catch(() => undefined)
  })

  const interactive = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return false

    const selector =
      "button, a, input, textarea, select, option, [role='button'], [role='menuitem'], [contenteditable='true'], [contenteditable='']"

    return !!target.closest(selector)
  }

  const drag = (e: MouseEvent) => {
    if (platform.platform !== "desktop") return
    if (e.buttons !== 1) return
    if (interactive(e.target)) return

    const win = getWin()
    if (!win?.startDragging) return

    e.preventDefault()
    void win.startDragging().catch(() => undefined)
  }

  return (
    // Zen hides the titlebar via `hidden`, not <Show>. Unmounting it destroys
    // the #opencode-titlebar-{center,right} portal targets that session-header
    // memoizes; on zen exit the header would portal into the stale detached
    // nodes and its search box / Share button would never reappear until a
    // reload. Keeping the element mounted preserves those targets. display:none
    // reclaims the full window height in zen (no wasted strip); the app flows
    // under the WCO controls, which just float in the top corner.
    <header
      data-slot="titlebar"
      data-wco={overlay() ? "" : undefined}
      class="@container/titlebar h-12 wide:h-10 shrink-0 bg-background-base relative"
      classList={{ hidden: layout.zen.opened() }}
      style={{
        "min-height": minHeight(),
        ...(overlay()
          ? {
              "margin-left": "env(titlebar-area-x, 0)",
              width: "env(titlebar-area-width, 100%)",
              height: "env(titlebar-area-height, auto)",
              "-webkit-app-region": "drag",
            }
          : {}),
      }}
    >
      {/* Mobile header: one flat flex row. Home + Menu here, session controls
          (search, status, keep-warm, stop, review) portal into
          #opencode-titlebar-mobile as direct siblings, so justify-between
          spreads all of them evenly across the width. */}
      <div class="expanded:hidden flex items-center justify-between size-full px-1 min-w-0 overflow-hidden">
        <IconButton
          icon="house-mobile"
          iconSize="medium"
          variant="ghost"
          class="size-10 shrink-0 rounded-md"
          onClick={goHome}
          aria-label={language.t("common.home")}
        />
        <IconButton
          icon="menu-mobile"
          iconSize="medium"
          variant="ghost"
          class="size-10 shrink-0 rounded-md"
          onClick={layout.overlaySidebar.toggle}
          aria-label={language.t("sidebar.menu.toggle")}
        />
        {/* Search + server indicator live here (not in SessionHeader) so they
            show on every route, including home. The session-only controls
            (keep-warm, stop, review) still portal into the mount below. */}
        <Tooltip value={language.t("session.header.searchFiles")} placement="bottom" gutter={8}>
          <IconButton
            icon="magnifying-glass"
            iconSize="medium"
            variant="ghost"
            class="size-10 shrink-0 p-0"
            onClick={() => command.trigger("file.open")}
            aria-label={language.t("session.header.searchFiles")}
          />
        </Tooltip>
        <StatusPopover />
        <Tooltip value={surfaceLabel()} placement="bottom" gutter={8}>
          <IconButton
            icon={shell.forced() ? "monitor-smartphone" : shell.compact() ? "monitor" : "smartphone"}
            iconSize="medium"
            variant={shell.forced() ? "primary" : "ghost"}
            class="size-10 shrink-0 p-0"
            onClick={shell.toggle}
            aria-label={surfaceLabel()}
          />
        </Tooltip>
        <div id="opencode-titlebar-mobile" class="contents" />
        {/* Reload pinned rightmost: installed PWA has no address-bar reload, so
            this is the in-app substitute, placed at the end of the row. */}
        <Show when={standalone()}>
          <Tooltip value={language.t("common.reload")} placement="bottom" gutter={8}>
            <IconButton
              icon="rotate-right"
              iconSize="medium"
              variant="ghost"
              class="size-10 shrink-0 p-0"
              onClick={() => platform.restart()}
              aria-label={language.t("common.reload")}
            />
          </Tooltip>
        </Show>
      </div>

      {/* minmax(0,auto) on the flanks rather than auto: a forced wide layout on
          a narrow window must still fit, and an auto track refuses to shrink
          below its content, so the centre column overflowed onto the controls
          beside it. */}
      <div class="hidden expanded:grid grid-cols-[minmax(0,auto)_minmax(0,1fr)_minmax(0,auto)] items-center size-full">
        <div
          classList={{
            "flex items-center min-w-0": true,
            "pl-2": !mac(),
          }}
          onMouseDown={drag}
        >
          <Show when={mac()}>
            <div class="h-full shrink-0" style={{ width: `${72 / zoom()}px` }} />
          </Show>
          <div class="flex items-center gap-3 shrink-0">
            <Tooltip
              class="flex shrink-0 ml-2"
              placement="bottom"
              value={language.t("common.home")}
              openDelay={2000}
            >
              <Button
                variant="ghost"
                icon="house"
                class="size-6 p-0"
                onClick={goHome}
                aria-label={language.t("common.home")}
              />
            </Tooltip>
            <TooltipKeybind
              class="flex shrink-0"
              placement="bottom"
              title={language.t("command.sidebar.toggle")}
              keybind={command.keybind("sidebar.toggle")}
            >
              <Button
                variant="ghost"
                class="group/sidebar-toggle size-6 p-0"
                onClick={layout.sidebar.toggle}
                aria-label={language.t("command.sidebar.toggle")}
                aria-expanded={layout.sidebar.opened()}
              >
                <div class="relative flex items-center justify-center size-4 [&>*]:absolute [&>*]:inset-0">
                  <Icon
                    size="small"
                    name={layout.sidebar.opened() ? "layout-left-full" : "layout-left"}
                    class="group-hover/sidebar-toggle:hidden"
                  />
                  <Icon
                    size="small"
                    name="layout-left-partial"
                    class="hidden group-hover/sidebar-toggle:inline-block"
                  />
                  <Icon
                    size="small"
                    name={layout.sidebar.opened() ? "layout-left" : "layout-left-full"}
                    class="hidden group-active/sidebar-toggle:inline-block"
                  />
                </div>
              </Button>
            </TooltipKeybind>
            <div class="flex items-center gap-1 shrink-0">
              <Tooltip placement="bottom" value={language.t("common.goBack")} openDelay={2000}>
                <Button
                  variant="ghost"
                  icon="arrow-left"
                  class="size-6 p-0"
                  disabled={!canBack()}
                  onClick={back}
                  aria-label={language.t("common.goBack")}
                />
              </Tooltip>
              <Tooltip placement="bottom" value={language.t("common.goForward")} openDelay={2000}>
                <Button
                  variant="ghost"
                  icon="arrow-right"
                  class="size-6 p-0"
                  disabled={!canForward()}
                  onClick={forward}
                  aria-label={language.t("common.goForward")}
                />
              </Tooltip>
              <Tooltip placement="bottom" value={surfaceLabel()} openDelay={2000}>
                <Button
                  variant={shell.forced() ? "primary" : "ghost"}
                  icon={shell.forced() ? "monitor-smartphone" : shell.compact() ? "monitor" : "smartphone"}
                  class="size-6 p-0"
                  onClick={shell.toggle}
                  aria-label={surfaceLabel()}
                />
              </Tooltip>
            </div>
          </div>
        </div>

        {/* Centred by the grid's middle column, which yields space to its
            neighbours rather than floating above them and covering controls. */}
        <div class="min-w-0 flex items-center justify-center">
          <div id="opencode-titlebar-center" class="w-full min-w-0 flex justify-center" />
        </div>

        <div
          classList={{
            "flex items-center min-w-0 justify-end": true,
            "pr-6": !windows(),
          }}
          onMouseDown={drag}
        >
          <div id="opencode-titlebar-right" class="flex items-center gap-3 shrink-0 justify-end">
            <StatusPopover />
          </div>
          <Show when={windows()}>
            <div class="w-6 shrink-0" />
            <div data-tauri-decorum-tb class="flex flex-row" />
          </Show>
        </div>
      </div>
    </header>
  )
}
