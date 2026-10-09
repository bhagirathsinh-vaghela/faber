import { describe, expect, test } from "bun:test"
import { followable } from "../../src/util/fetch"

describe("followable", () => {
  test("a hop on the same host, scheme and port is followed", () => {
    expect(followable("https://example.com/a", "https://www.example.com/b")).toBe(true)
    expect(followable("http://localhost:8080/a", "http://localhost:8080/b")).toBe(true)
  })

  test("an http to https upgrade on the default ports is followed", () => {
    expect(followable("http://example.com/a", "https://example.com/a")).toBe(true)
  })

  test("a downgrade, a port change or another host is not", () => {
    expect(
      [
        ["https://example.com/a", "http://example.com/a"],
        ["https://example.com/a", "https://example.com:8443/a"],
        ["http://example.com:8080/a", "https://example.com/a"],
        ["https://example.com/a", "https://evil.example/a"],
      ].map(([a, b]) => followable(a, b)),
    ).toEqual([false, false, false, false])
  })
})
