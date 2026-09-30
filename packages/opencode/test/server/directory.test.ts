import { expect, test } from "bun:test"
import { Directory } from "../../src/server/directory"
import { directoryHeader } from "@opencode-ai/sdk/v2/client"

const request = (query?: string, header?: string) => ({
  query: (name: string) => (name === "directory" ? query : undefined),
  header: (name: string) => (name === "x-opencode-directory" ? header : undefined),
})

test("a path sent in the header comes back exactly, including a literal %", () => {
  for (const path of ["/Users/me/project", "/Users/me/a%41b", "/Users/me/café"])
    expect(Directory.from(request(undefined, directoryHeader(path)))).toBe(path)
})

test("the query value is used as given, never decoded a second time", () => {
  expect(Directory.from(request("/Users/me/a%41b", directoryHeader("/elsewhere")))).toBe("/Users/me/a%41b")
})

test("a header that is not valid URI encoding is taken as written", () => {
  expect(Directory.from(request(undefined, "/Users/me/100%"))).toBe("/Users/me/100%")
})

test("with neither, the server's own directory", () => {
  expect(Directory.from(request())).toBe(process.cwd())
})
