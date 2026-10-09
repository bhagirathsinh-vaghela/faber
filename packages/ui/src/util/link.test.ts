import { describe, expect, test } from "bun:test"
import { safeHref } from "./link"

describe("safeHref", () => {
  test("web, mail, relative and fragment links pass unchanged", () => {
    const links = ["https://example.com/a?b=1", "http://localhost:3000", "mailto:a@example.com", "/docs/x", "#top", ""]
    expect(links.map(safeHref)).toEqual(links)
  })

  test("script, file, data and custom schemes are dropped", () => {
    expect(
      ["javascript:alert(1)", "JavaScript:alert(1)", "file:///etc/passwd", "data:text/html,x", "vscode://x"].map(
        safeHref,
      ),
    ).toEqual([undefined, undefined, undefined, undefined, undefined])
  })

  test("a scheme split by whitespace the browser strips is still dropped", () => {
    expect(["jav\tascript:alert(1)", "java\nscript:alert(1)", " \u0001javascript:alert(1)"].map(safeHref)).toEqual([
      undefined,
      undefined,
      undefined,
    ])
  })

  test("no href stays no href", () => {
    expect(safeHref(undefined)).toBeUndefined()
  })
})
