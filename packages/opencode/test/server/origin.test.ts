import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { Origin } from "../../src/server/origin"

const request = (headers: Record<string, string>) => new Request("http://127.0.0.1:4096/x", { headers })

afterEach(() => Origin.trust([]))

describe("Origin.foreign", () => {
  test("a request with no Origin is not foreign", () => {
    expect(Origin.foreign(request({ host: "127.0.0.1:4096" }))).toBe(false)
  })

  test("the page's own origin is not foreign", () => {
    expect(Origin.foreign(request({ host: "127.0.0.1:4096", origin: "http://127.0.0.1:4096" }))).toBe(false)
  })

  test("another host is foreign", () => {
    expect(Origin.foreign(request({ host: "127.0.0.1:4096", origin: "https://evil.example" }))).toBe(true)
  })

  test("the same host on another port is foreign", () => {
    expect(Origin.foreign(request({ host: "127.0.0.1:4096", origin: "http://127.0.0.1:5173" }))).toBe(true)
  })

  test("an opaque origin is foreign", () => {
    expect(Origin.foreign(request({ host: "127.0.0.1:4096", origin: "null" }))).toBe(true)
  })
})

describe("Origin.allowed", () => {
  test("local dev servers and the desktop shell", () => {
    expect(["http://localhost:3000", "http://127.0.0.1:5173", "tauri://localhost"].map(Origin.allowed)).toEqual([
      true,
      true,
      true,
    ])
  })

  test("opencode.ai pages and an unknown site are refused", () => {
    expect(
      ["https://app.opencode.ai", "https://opencode.ai", "http://app.opencode.ai", "https://evil.example"].map(
        Origin.allowed,
      ),
    ).toEqual([false, false, false, false])
  })

  test("a --cors origin is allowed once trusted", () => {
    expect(Origin.allowed("https://ui.example")).toBe(false)
    Origin.trust(["https://ui.example"])
    expect(Origin.allowed("https://ui.example")).toBe(true)
  })
})

describe("Origin.socket", () => {
  const app = new Hono().get("/ws", Origin.socket, (c) => c.text("upgraded"))
  const open = async (headers: Record<string, string>) =>
    app.request("http://127.0.0.1:4096/ws", { headers: { host: "127.0.0.1:4096", ...headers } })

  test("refuses a handshake from another site's page", async () => {
    const response = await open({ origin: "https://evil.example" })
    expect([response.status, await response.text()]).toEqual([403, "cross-origin WebSocket refused"])
  })

  test("refuses a handshake from an opencode.ai page", async () => {
    const response = await open({ origin: "https://app.opencode.ai" })
    expect([response.status, await response.text()]).toEqual([403, "cross-origin WebSocket refused"])
  })

  test("passes the server's own page, an allowed origin, and a client with no Origin", async () => {
    const cases: Record<string, string>[] = [
      { origin: "http://127.0.0.1:4096" },
      { origin: "http://localhost:3000" },
      {},
    ]
    const statuses = await Promise.all(cases.map((headers) => open(headers).then((response) => response.status)))
    expect(statuses).toEqual([200, 200, 200])
  })
})

describe("Origin.host", () => {
  test("names a rebinding page cannot use are accepted", () => {
    Origin.trust(["https://ui.example"], "box.local")
    const accepted = [
      "127.0.0.1:4096",
      "[::1]:4096",
      "192.168.1.20:4096",
      "localhost:4096",
      "app.localhost",
      "box.local",
      "ui.example",
    ]
    expect(accepted.map(Origin.host)).toEqual(accepted.map(() => true))
  })

  test("any other DNS name, or no Host, is refused", () => {
    Origin.trust([])
    expect(
      ["attacker.example:4096", "rebind.attacker.example", "opencode.local", "", undefined].map(Origin.host),
    ).toEqual([false, false, false, false, false])
  })
})

describe("server Host guard without a password", () => {
  test("a request whose Host is a foreign DNS name gets 403, a loopback one gets through", async () => {
    const { Server } = await import("../../src/server/server")
    const foreign = await Server.App().request("http://attacker.example:4096/global/health", {
      headers: { host: "attacker.example:4096" },
    })
    const local = await Server.App().request("http://127.0.0.1:4096/global/health", {
      headers: { host: "127.0.0.1:4096" },
    })
    expect([foreign.status, local.status]).toEqual([403, 200])
  })
})

describe("server Host guard over a raw socket", () => {
  test("an HTTP/1.0 request with no Host is refused with 403, not a 500 that leaks paths", async () => {
    const { Server } = await import("../../src/server/server")
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: Server.App().fetch })
    const reply = await new Promise<string>((resolve) => {
      let text = ""
      Bun.connect({
        hostname: "127.0.0.1",
        port: server.port!,
        socket: {
          open: (socket) => void socket.write("GET /global/health HTTP/1.0\r\n\r\n"),
          data: (_socket, chunk) => void (text += chunk.toString()),
          close: () => resolve(text),
        },
      })
    })
    server.stop(true)
    expect(reply.split("\r\n")[0]).toBe("HTTP/1.1 403 Forbidden")
  })
})
