import type { MiddlewareHandler } from "hono"

export namespace Origin {
  let trusted: string[] = []

  export function trust(list: string[]) {
    trusted = list
  }

  // The browser origins the server answers cross-origin: local dev servers,
  // the desktop shell, *.opencode.ai over https, and any `--cors` origin.
  export function allowed(input: string) {
    if (input.startsWith("http://localhost:")) return true
    if (input.startsWith("http://127.0.0.1:")) return true
    if (input === "tauri://localhost" || input === "http://tauri.localhost") return true
    if (/^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/.test(input)) return true
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
