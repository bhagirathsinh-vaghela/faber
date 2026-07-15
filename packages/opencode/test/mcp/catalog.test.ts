import { describe, expect, test } from "bun:test"
import { McpCatalog } from "../../src/mcp/catalog"
import type { MCP } from "../../src/mcp"

function entry(over: Partial<MCP.CorpusEntry> & Pick<MCP.CorpusEntry, "key" | "client">): MCP.CorpusEntry {
  return {
    tier: "name",
    name: over.key,
    description: `desc for ${over.key}`,
    schema: { type: "object", properties: { q: { type: "string" } } },
    ...over,
  }
}

describe("McpCatalog.renderTool", () => {
  test("name tier: only the key, no description or schema (names are the floor)", () => {
    const out = McpCatalog.renderTool(entry({ key: "notion_search", client: "notion" }), "name")
    expect(out).toEqual({ name: "notion_search" })
  })

  test("description tier: key + description, no schema", () => {
    const out = McpCatalog.renderTool(entry({ key: "notion_search", client: "notion" }), "description")
    expect(out).toEqual({ name: "notion_search", description: "desc for notion_search" })
  })

  test("full tier: key + description + input_schema", () => {
    const e = entry({ key: "notion_search", client: "notion" })
    const out = McpCatalog.renderTool(e, "full")
    expect(out).toEqual({
      name: "notion_search",
      description: "desc for notion_search",
      input_schema: e.schema,
    })
  })
})

describe("McpCatalog.build", () => {
  test("returns undefined for an empty corpus", () => {
    expect(McpCatalog.build([])).toBeUndefined()
  })

  test("groups by server, sorts servers then tools, honors per-server tier", () => {
    const text = McpCatalog.build([
      entry({ key: "notion_search", client: "notion", tier: "description" }),
      entry({ key: "notion_fetch", client: "notion", tier: "description" }),
      entry({ key: "datadog_logs", client: "datadog", tier: "name" }),
    ])!
    const json = JSON.parse(text.slice(text.indexOf("[{"), text.lastIndexOf("}]") + 2))
    // datadog sorts before notion
    expect(json.map((g: any) => g.server)).toEqual(["datadog", "notion"])
    // datadog is name-tier: name only
    expect(json[0].tools).toEqual([{ name: "datadog_logs" }])
    // notion is description-tier, tools sorted: fetch before search
    expect(json[1].tools).toEqual([
      { name: "notion_fetch", description: "desc for notion_fetch" },
      { name: "notion_search", description: "desc for notion_search" },
    ])
  })

  test("is byte-identical regardless of input order (shared-cache invariant)", () => {
    const a = McpCatalog.build([
      entry({ key: "notion_search", client: "notion", tier: "full" }),
      entry({ key: "datadog_logs", client: "datadog", tier: "name" }),
    ])
    const b = McpCatalog.build([
      entry({ key: "datadog_logs", client: "datadog", tier: "name" }),
      entry({ key: "notion_search", client: "notion", tier: "full" }),
    ])
    expect(a).toBe(b as string)
  })

  test("names are always present even at name tier", () => {
    const text = McpCatalog.build([entry({ key: "slack_post", client: "slack", tier: "name" })])!
    expect(text).toContain("slack_post")
  })
})
