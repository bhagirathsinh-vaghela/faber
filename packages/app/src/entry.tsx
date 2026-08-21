// @refresh reload
import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "@/app"
import { Platform, PlatformProvider } from "@/context/platform"
import { dict as en } from "@/i18n/en"
import pkg from "../package.json"

const DEFAULT_SERVER_URL_KEY = "opencode.settings.dat:defaultServerUrl"

// The message list is JS-scroll-controlled and restores its own position on
// load; the browser's native restore would fight it, so disable it.
if ("scrollRestoration" in history) history.scrollRestoration = "manual"

const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(en["error.dev.rootNotFound"])
}

// iOS Safari does not implement the (display-mode: standalone) media query and
// reports an installed PWA through navigator.standalone instead, so a
// query-only CSS gate is false on the one platform whose safe-area insets
// matter. Publish both signals as an attribute the stylesheet can gate on.
// Chromium and desktop installs can enter and leave standalone at runtime.
if (root) {
  const display = window.matchMedia("(display-mode: standalone)")
  const flag = () =>
    root.toggleAttribute(
      "data-standalone",
      display.matches || (navigator as unknown as { standalone?: boolean }).standalone === true,
    )
  display.addEventListener("change", flag)
  flag()
}

// iOS standalone PWA only (navigator.standalone exists nowhere else): the
// layout viewport shrinks for the soft keyboard but does not reliably grow
// back on dismissal, so 100dvh sticks at the shrunken height until a refocus.
// visualViewport.height is the only truthful size; drive the root off it and
// reset the keyboard pan (scrollTo), else a top-anchored root shrinks into a
// strip above the fold. resize alone is not reliably fired across keyboard
// transitions, so focus/pageshow also trigger, each settling over ~600ms.
const viewport = window.visualViewport
if (root && viewport && (navigator as unknown as { standalone?: boolean }).standalone === true) {
  // vvH alone cannot classify keyboard state: after a blur-driven dismissal
  // (the dock's keyboard toggle) iOS keeps reporting the shrunken height with
  // no event and no update — the small vvH is the lie. Focus is the signal the
  // OS cannot fake, since a soft keyboard only exists for a focused editable.
  const editing = () => {
    const el = document.activeElement
    return !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || (el as HTMLElement).isContentEditable)
  }

  // The window is the frame to fit, never the device: the same PWA runs as an
  // iPad Split View pane, a Stage Manager window, and an iPadOS windowed app,
  // all smaller than the display, so screen.height would size a bottom-anchored
  // layout past the window bottom and the root's overflow:hidden would clip the
  // dock away. innerHeight is the window but the keyboard shrinks it and WebKit
  // can leave it stuck short, so hold the largest height this window has
  // reported — growth is always real, nothing but a bigger window produces it.
  let width = window.innerWidth
  let full = 0
  const measure = () => {
    // A width change is the unambiguous window-resized signal, since a keyboard
    // only ever changes height. Rotation, Split View and a window drag all
    // cross it, and the held height then describes a box that no longer exists.
    const reset = window.innerWidth !== width
    width = window.innerWidth
    // iOS reports 0 (and the insets as 0) while a cold-started PWA settles, so
    // a reading is only evidence once it is positive. Latching a 0 would pin
    // the root at zero height, and every later reading is discarded by the same
    // max() that is meant to recover it.
    if (window.innerHeight <= 0) return
    full = reset ? window.innerHeight : Math.max(full, window.innerHeight)
  }

  // Keyboard up, vvH is honest but iOS may pan the layout viewport (offsetTop >
  // 0) to keep the focused input visible and scrollTo cannot always reset it; a
  // top-anchored root then ends offsetTop short of the keyboard. vvH + offsetTop
  // reaches the keyboard's top edge in either pan state.
  const keyboard = () => editing() && viewport.height < full - 300
  const height = () => (keyboard() ? Math.round(viewport.height + viewport.offsetTop) : full)

  // WebKit can leave the viewport stuck short after a standalone keyboard
  // dismissal while firing nothing, so no listener can observe a recovery that
  // never happens. Toggling display on a full-height element with a synchronous
  // reflow between forces the re-measure, restoring the browser's own numbers
  // for everything else on the page that reads them.
  const unstick = () => {
    if (editing() || window.innerHeight >= full - 4) return
    root.style.display = "none"
    void root.offsetHeight
    root.style.display = ""
  }

  let raf = 0
  const fit = () => {
    measure()
    // A 0 height would blank the app; the class-supplied h-dvh holds visibility
    // until a positive reading arrives.
    if (full <= 0) return
    root.style.height = `${height()}px`
    root.toggleAttribute("data-keyboard", keyboard())
    // Fixed-position elements resolve against the layout viewport, which iOS
    // leaves full-height behind the keyboard, so anything anchored to the
    // window bottom lands under it while the root stops at the keyboard's top
    // edge. Publish the gap between the two so such an element can bridge it.
    document.documentElement.style.setProperty("--keyboard-inset", `${Math.max(0, full - height())}px`)
    window.scrollTo(0, 0)
  }
  const settle = () => {
    cancelAnimationFrame(raf)
    const until = performance.now() + 600
    const step = () => {
      fit()
      if (performance.now() < until) raf = requestAnimationFrame(step)
    }
    step()
  }
  viewport.addEventListener("resize", settle)
  viewport.addEventListener("scroll", settle)
  window.addEventListener("focusin", settle)
  window.addEventListener("pageshow", settle)
  window.addEventListener("focusout", () => {
    settle()
    // The keyboard needs ~140ms to finish closing; measuring before that reads
    // a mid-animation size and mistakes it for the settled one.
    setTimeout(() => {
      unstick()
      settle()
    }, 140)
  })
  fit()
  // Watchdog: iOS drops all of the above across some keyboard transitions
  // (observed: dismiss via the keyboard's own collapse key — no focusout, no
  // resize), leaving the root stuck at the stale height until the next event.
  // Poll cheaply and re-fit only on drift, so a missed event costs at most one
  // tick instead of persisting until refocus.
  // measure() runs unconditionally, never behind the drift test it feeds: a
  // stale height compares equal to itself, reporting no drift and suppressing
  // the only call that could refresh it.
  setInterval(() => {
    measure()
    if (Math.abs((parseFloat(root.style.height) || 0) - height()) > 1 || window.scrollY !== 0) fit()
  }, 300)
}

const platform: Platform = {
  platform: "web",
  version: pkg.version,
  openLink(url: string) {
    window.open(url, "_blank")
  },
  back() {
    window.history.back()
  },
  forward() {
    window.history.forward()
  },
  restart: async () => {
    window.location.reload()
  },
  notify: async (title, description, href) => {
    if (!("Notification" in window)) return

    const permission =
      Notification.permission === "default"
        ? await Notification.requestPermission().catch(() => "denied")
        : Notification.permission

    if (permission !== "granted") return

    const inView = document.visibilityState === "visible" && document.hasFocus()
    if (inView) return

    await Promise.resolve()
      .then(() => {
        const notification = new Notification(title, {
          body: description ?? "",
          icon: "https://opencode.ai/favicon-96x96-v3.png",
        })
        notification.onclick = () => {
          window.focus()
          if (href) {
            window.history.pushState(null, "", href)
            window.dispatchEvent(new PopStateEvent("popstate"))
          }
          notification.close()
        }
      })
      .catch(() => undefined)
  },
  getDefaultServerUrl: () => {
    if (typeof localStorage === "undefined") return null
    try {
      return localStorage.getItem(DEFAULT_SERVER_URL_KEY)
    } catch {
      return null
    }
  },
  setDefaultServerUrl: (url) => {
    if (typeof localStorage === "undefined") return
    try {
      if (url) {
        localStorage.setItem(DEFAULT_SERVER_URL_KEY, url)
        return
      }
      localStorage.removeItem(DEFAULT_SERVER_URL_KEY)
    } catch {
      return
    }
  },
}

render(
  () => (
    <PlatformProvider value={platform}>
      <AppBaseProviders>
        <AppInterface />
      </AppBaseProviders>
    </PlatformProvider>
  ),
  root!,
)

// Registering the worker also makes the app installable as a PWA (desktop
// standalone window, iOS home-screen app). It caches the immutable /assets/*
// so a flaky link cannot break a lazily imported route — see public/sw.js.
// DEV is skipped so it can't interfere with Vite HMR.
if (!import.meta.env.DEV && "serviceWorker" in navigator)
  navigator.serviceWorker.register("/sw.js").catch(() => undefined)
