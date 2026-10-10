import type { MiddlewareHandler } from "hono"

import os from "os"
import { isIP } from "net"

export namespace Origin {
  let trusted: string[] = []
  let names: string[] = []

  export function trust(list: string[], mdns?: string) {
    trusted = list
    names = [
      os.hostname().toLowerCase(),
      os
        .hostname()
        .toLowerCase()
        .replace(/\.local$/, "") + ".local",
      ...(mdns ? [mdns.toLowerCase()] : []),
      ...list.filter((origin) => URL.canParse(origin)).map((origin) => new URL(origin).hostname.toLowerCase()),
    ]
  }
  trust([])

  // A page whose DNS name rebinds to this machine is same-origin with the
  // server, so without a password only Host names that cannot be rebound are
  // answered: IP literals, localhost, this machine's own names and `--cors`
  // hosts. With a password, basic auth stops such a page instead.
  export function host(value: string | undefined) {
    if (!value || !URL.canParse(`http://${value}`)) return false
    const name = new URL(`http://${value}`).hostname.toLowerCase().replace(/^\[|\]$/g, "")
    if (isIP(name)) return true
    if (name === "localhost" || name.endsWith(".localhost")) return true
    return names.includes(name)
  }

  // The browser origins the server answers cross-origin: local dev servers,
  // the desktop shell, and any `--cors` origin.
  export function allowed(input: string) {
    if (input.startsWith("http://localhost:")) return true
    if (input.startsWith("http://127.0.0.1:")) return true
    if (input === "tauri://localhost" || input === "http://tauri.localhost") return true
    return trusted.includes(input)
  }

  // A browser sends Origin on every WebSocket handshake (RFC 6455 section 4.1)
  // and on every cross-site POST (Fetch standard, "origin header"), so a request
  // whose Origin names another host came from another site's page. No Origin
  // means a non-browser client (curl, the CLI), which CORS never covered either.
  export function foreign(req: Request) {
    const origin = req.headers.get("origin")
    if (!origin) return false
    if (!URL.canParse(origin)) return true
    return new URL(origin).host !== req.headers.get("host")
  }

  // CORS does not apply to a WebSocket upgrade, so without this any page the
  // user visits could open the dictation or terminal socket.
  export const socket: MiddlewareHandler = async (c, next) => {
    const origin = c.req.header("origin")
    if (foreign(c.req.raw) && !(origin && allowed(origin))) return c.text("cross-origin WebSocket refused", 403)
    return next()
  }
}
