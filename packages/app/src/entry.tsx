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

// iOS standalone PWA only (navigator.standalone exists nowhere else): the
// layout viewport shrinks for the soft keyboard but does not reliably grow
// back on dismissal, so 100dvh sticks at the shrunken height until a refocus.
// visualViewport.height is the only truthful size; drive the root off it and
// reset the keyboard pan (scrollTo), else a top-anchored root shrinks into a
// strip above the fold. resize alone is not reliably fired across keyboard
// transitions, so focus/pageshow also trigger, each settling over ~600ms.
const viewport = window.visualViewport
if (root && viewport && (navigator as unknown as { standalone?: boolean }).standalone === true) {
  // Keyboard DOWN, iOS can leave the whole viewport stack stuck ~62px short
  // (vvH and innerHeight both read short, offsetTop 0) — no API reports the
  // truth, so clamp to screen.height (standalone + viewport-fit=cover owns the
  // screen). Keyboard UP, vvH is honest but iOS may pan the layout viewport
  // (offsetTop > 0) to keep the focused input visible and scrollTo cannot
  // always reset it; a top-anchored root then ends offsetTop short of the
  // keyboard. vvH + offsetTop reaches the keyboard's top edge in either pan
  // state. iOS screen sizes are portrait-locked; pick the axis by orientation.
  // vvH alone cannot classify keyboard state: after a blur-driven dismissal
  // (the dock's keyboard toggle) iOS keeps reporting the shrunken height with
  // no event and no update — the small vvH IS the lie. Focus is the truth
  // signal the OS can't fake: the iPhone soft keyboard only exists for a
  // focused editable. Small vvH without one = stale, clamp to full.
  const editing = () => {
    const el = document.activeElement
    return !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || (el as HTMLElement).isContentEditable)
  }
  let raf = 0
  const fit = () => {
    const portrait = window.matchMedia("(orientation: portrait)").matches
    const full = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height)
    const keyboard = editing() && viewport.height < full - 300
    const height = keyboard ? Math.round(viewport.height + viewport.offsetTop) : full
    root.style.height = `${height}px`
    root.toggleAttribute("data-keyboard", keyboard)
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
  window.addEventListener("focusout", settle)
  window.addEventListener("pageshow", settle)
  fit()
  // Watchdog: iOS drops all of the above across some keyboard transitions
  // (observed: dismiss via the keyboard's own collapse key — no focusout, no
  // resize), leaving the root stuck at the stale height until the next event.
  // Poll cheaply and re-fit only on drift, so a missed event costs at most one
  // tick instead of persisting until refocus.
  setInterval(() => {
    const height = parseFloat(root.style.height) || 0
    const portrait = window.matchMedia("(orientation: portrait)").matches
    const full = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height)
    const keyboard = editing() && viewport.height < full - 300
    const target = keyboard ? Math.round(viewport.height + viewport.offsetTop) : full
    if (Math.abs(height - target) > 1 || window.scrollY !== 0) fit()
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
