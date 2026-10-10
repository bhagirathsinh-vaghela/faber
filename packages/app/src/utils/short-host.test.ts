import { describe, expect, test } from "bun:test"
import { shortHost } from "./short-host"

describe("shortHost", () => {
  test("keeps the first label of a hostname", () => {
    expect(shortHost("my-host.example.ts.net")).toBe("my-host")
  })

  test("drops the port", () => {
    expect(shortHost("my-host.example.ts.net:4096")).toBe("my-host")
    expect(shortHost("localhost:4096")).toBe("localhost")
  })

  test("keeps an IPv4 address whole", () => {
    expect(shortHost("10.0.0.5")).toBe("10.0.0.5")
    expect(shortHost("10.0.0.5:4096")).toBe("10.0.0.5")
  })

  test("keeps a bracketed IPv6 address whole", () => {
    expect(shortHost("[::1]:4096")).toBe("[::1]")
  })

  test("falls back to the input when there is no first label", () => {
    expect(shortHost(".local")).toBe(".local")
  })
})
