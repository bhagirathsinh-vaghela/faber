import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { basicAuth } from "hono/basic-auth"
import { admitted, credentials, launched } from "../../src/cli/cmd/supervise"

describe("launched", () => {
  test("a compiled serve on the port is the supervisor's", () => {
    expect(launched("/usr/local/bin/opencode serve --port 4097 --hostname 127.0.0.1", 4097)).toBe(true)
  })

  test("a source-run serve on the port is the supervisor's", () => {
    expect(launched("bun run --conditions=browser src/index.ts serve --port 4098 --hostname 0.0.0.0", 4098)).toBe(true)
  })

  test("a serve on another port is not", () => {
    expect(launched("opencode serve --port 40970 --hostname 127.0.0.1", 4097)).toBe(false)
  })

  test("an unrelated listener on the port is not", () => {
    expect(launched("python3 -m http.server 4097", 4097)).toBe(false)
  })
})

describe("credentials", () => {
  // The same guard server.ts puts in front of every route when a password is set.
  const guarded = new Hono()
    .use(basicAuth({ username: "opencode", password: "pw" }))
    .get("/global/health", (c) => c.json({ healthy: true }))

  test("the probe's credentials pass the server's basic auth", async () => {
    const response = await guarded.request("/global/health", { headers: credentials("pw", undefined) })
    expect(response.status).toBe(200)
  })

  test("non-ASCII credentials are encoded the way the server decodes them", async () => {
    const cases = [
      ["opencode", "pässword"],
      ["opencode", "密码"],
      ["jöhn", "pw"],
    ]
    const statuses = await Promise.all(
      cases.map(async ([username, password]) => {
        const guard = new Hono()
          .use(basicAuth({ username, password }))
          .get("/global/health", (c) => c.json({ healthy: true }))
        return (await guard.request("/global/health", { headers: credentials(password, username) })).status
      }),
    )
    expect(statuses).toEqual([200, 200, 200])
  })

  test("no password sends no credentials", () => {
    expect(credentials(undefined, undefined)).toEqual({})
  })
})

describe("admitted", () => {
  const request = (headers: Record<string, string>) => new Request("http://localhost/stop", { method: "POST", headers })

  test("with a password set, only the server's credentials are admitted", () => {
    expect(admitted(request(credentials("pw", undefined)), "pw")).toBe(true)
    expect(admitted(request({}), "pw")).toBe(false)
    expect(admitted(request(credentials("other", undefined)), "pw")).toBe(false)
  })

  test("the scheme name is matched without regard to case", () => {
    const token = credentials("pw", undefined).Authorization.slice("Basic ".length)
    expect(admitted(request({ Authorization: `basic ${token}` }), "pw")).toBe(true)
  })

  test("with no password everything is admitted", () => {
    expect(admitted(request({}), undefined)).toBe(true)
  })
})
