import { expect, test } from "bun:test"
import { marked } from "marked"
import { fence, genericArgs } from "./message-part"

test("an empty-string argument still shows, so two calls stay distinct", () => {
  expect(genericArgs({ query: "", limit: 5 })).toEqual(["query=", "limit=5"])
})

test("output containing a fence stays inside one code block", () => {
  const output = "before\n```\nmiddle\n````\nafter"
  const tokens = marked.lexer(fence(output))
  expect(tokens.map((t) => t.type)).toEqual(["code"])
  expect((tokens[0] as { text: string }).text).toBe(output)
})
