import { describe, expect, test } from "bun:test"
import { Web } from "../../src/server/web"

const body = Buffer.from("<!doctype html>").toString("base64")

describe("Web.serve revalidation", () => {
  Web.load({ "/index.html": { type: "text/html", body, gzip: body } })
  const etag = Web.serve("/index.html")!.headers.get("ETag")!

  test("a 304 carries the Vary of the 200", () => {
    const response = Web.serve("/index.html", "gzip", etag)!
    expect(response.status).toBe(304)
    expect(response.headers.get("Vary")).toBe("Accept-Encoding")
  })

  test("a weak or listed validator matches", () => {
    expect(Web.serve("/index.html", undefined, `W/${etag}`)!.status).toBe(304)
    expect(Web.serve("/index.html", undefined, `"other", ${etag}`)!.status).toBe(304)
    expect(Web.serve("/index.html", undefined, "*")!.status).toBe(304)
  })

  test("a different validator gets the body", () => {
    expect(Web.serve("/index.html", undefined, `"other"`)!.status).toBe(200)
  })
})
