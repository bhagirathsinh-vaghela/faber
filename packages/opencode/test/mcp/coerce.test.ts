import { describe, test, expect } from "bun:test"
import type { JSONSchema7 } from "ai"
import { MCP } from "../../src/mcp"

// When the model calls an MCP tool from the catalog without its full schema in
// view, it often emits stringly-typed args. MCP.coerceArgs converts
// string-encoded primitives back to the declared type before the call.
describe("MCP.coerceArgs", () => {
  const schema: JSONSchema7 = {
    type: "object",
    properties: {
      a: { type: "number" },
      b: { type: "integer" },
      flag: { type: "boolean" },
      name: { type: "string" },
      nested: { type: "object", properties: { n: { type: "number" } } },
      list: { type: "array", items: { type: "number" } },
    },
  }

  test("coerces string-encoded numbers, integers, and booleans", () => {
    expect(MCP.coerceArgs({ a: "17", b: "25.9", flag: "true" }, schema)).toEqual({ a: 17, b: 25, flag: true })
    expect(MCP.coerceArgs({ flag: "false" }, schema)).toEqual({ flag: false })
  })

  test("leaves correctly-typed values untouched", () => {
    expect(MCP.coerceArgs({ a: 17, flag: true, name: "x" }, schema)).toEqual({ a: 17, flag: true, name: "x" })
  })

  test("does not coerce strings for string-typed fields", () => {
    expect(MCP.coerceArgs({ name: "42" }, schema)).toEqual({ name: "42" })
  })

  test("leaves non-numeric strings alone", () => {
    expect(MCP.coerceArgs({ a: "not-a-number" }, schema)).toEqual({ a: "not-a-number" })
  })

  test("coerces nested objects and array items", () => {
    expect(MCP.coerceArgs({ nested: { n: "3" }, list: ["1", "2", "3"] }, schema)).toEqual({
      nested: { n: 3 },
      list: [1, 2, 3],
    })
  })

  test("passes through keys not in the schema", () => {
    expect(MCP.coerceArgs({ extra: "keep" }, schema)).toEqual({ extra: "keep" })
  })
})
