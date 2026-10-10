import { describe, expect, test } from "bun:test"
import { Web } from "../../src/server/web"

const body = Buffer.from("<!doctype html>").toString("base64")

describe("Web.serve revalidation", () => {
  Web.load({ "/index.html": { type: "text/html", body, gzip: body } })
  const etag = Web.serve("/index.html")!.headers.get("ETag")!

  test("the validator is weak and the same for every encoding", () => {
    expect(etag).toMatch(/^W\/"[0-9a-z]+"$/)
    expect(Web.serve("/index.html", "gzip")!.headers.get("Content-Encoding")).toBe("gzip")
    expect(Web.serve("/index.html", "gzip")!.headers.get("ETag")).toBe(etag)
  })

  test("a 304 carries the Vary of the 200", () => {
    const response = Web.serve("/index.html", "gzip", etag)!
    expect(response.status).toBe(304)
    expect(response.headers.get("Vary")).toBe("Accept-Encoding")
  })

  test("a weak, strong-form or listed validator matches", () => {
    expect(Web.serve("/index.html", undefined, etag)!.status).toBe(304)
    expect(Web.serve("/index.html", undefined, etag.slice(2))!.status).toBe(304)
    expect(Web.serve("/index.html", undefined, `"other", ${etag}`)!.status).toBe(304)
    expect(Web.serve("/index.html", undefined, "*")!.status).toBe(304)
  })

  test("a different validator gets the body", () => {
    expect(Web.serve("/index.html", undefined, `"other"`)!.status).toBe(200)
  })
})

describe("Web.serve CSP", () => {
  test("workers load only from this origin", () => {
    Web.load({ "/index.html": { type: "text/html", body } })
    const policy = Web.serve("/index.html")!.headers.get("Content-Security-Policy")!
    expect(policy.split("; ").find((directive) => directive.startsWith("worker-src"))).toBe("worker-src 'self'")
  })
})
