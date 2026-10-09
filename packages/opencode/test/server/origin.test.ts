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
  test("local dev servers, the desktop shell and opencode.ai over https", () => {
    expect(
      ["http://localhost:3000", "http://127.0.0.1:5173", "tauri://localhost", "https://app.opencode.ai"].map(
        Origin.allowed,
      ),
    ).toEqual([true, true, true, true])
  })

  test("a plain-http opencode.ai and an unknown site are refused", () => {
    expect(["http://app.opencode.ai", "https://evil.example"].map(Origin.allowed)).toEqual([false, false])
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
