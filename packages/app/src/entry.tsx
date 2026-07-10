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

// Register the no-op service worker so the app is installable as a PWA
// (desktop standalone window, iOS home-screen app). It caches nothing — see
// public/sw.js. DEV is skipped so it can't interfere with Vite HMR.
if (!import.meta.env.DEV && "serviceWorker" in navigator)
  navigator.serviceWorker.register("/sw.js").catch(() => undefined)
