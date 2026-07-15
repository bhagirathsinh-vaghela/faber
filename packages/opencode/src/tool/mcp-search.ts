import z from "zod"
import { Tool } from "./tool"
import { MCP } from "../mcp"
import { McpCatalog } from "../mcp/catalog"
import DESCRIPTION from "./mcp-search.txt"

// Progressive-disclosure companion to the <mcp_tool_catalog> block. The catalog
// lists MCP tools at each server's configured tier (name-only by default);
// mcp_search hands back whatever detail the catalog omitted — a description, an
// input schema, or both — for the tools the model wants to call. The disclosed
// content lands in this tool's result and stays in history, so a repeat call
// needs no re-search.
export const McpSearchTool = Tool.define("mcp_search", async () => {
  return {
    description: DESCRIPTION,
    parameters: z
      .object({
        select: z
          .array(z.string())
          .optional()
          .describe(
            'Exact tool key(s) to disclose (as shown in the mcp_tool_catalog, e.g. "notion_search"). Use when you already know which tool you want.',
          ),
        query: z
          .string()
          .optional()
          .describe(
            "Keyword(s) to search across every MCP tool's name and description. Use to discover tools when the names alone are uninformative. Matches the full tool corpus regardless of catalog tier.",
          ),
        want: z
          .enum(["description", "schema", "full"])
          .optional()
          .describe(
            'How much detail to return per matched tool: "description" (name + description), "schema" (name + input schema), or "full" (both). Defaults to "full".',
          ),
      })
      .strict(),
    async execute(params) {
      if (!params.select?.length && !params.query) {
        return {
          title: "mcp_search",
          metadata: { matches: 0 },
          output: 'Provide "select" (exact tool keys) and/or "query" (keyword search).',
        }
      }

      const corpus = await MCP.corpus()
      if (corpus.length === 0) {
        return {
          title: "mcp_search",
          metadata: { matches: 0 },
          output: "No MCP tools are available.",
        }
      }

      const selected = new Map<string, MCP.CorpusEntry>()

      if (params.select?.length) {
        const byKey = new Map(corpus.map((entry) => [entry.key, entry]))
        for (const key of params.select) {
          const entry = byKey.get(key)
          if (entry) selected.set(entry.key, entry)
        }
      }

      if (params.query) {
        const terms = params.query.toLowerCase().split(/\s+/).filter(Boolean)
        for (const entry of corpus) {
          const haystack = `${entry.key} ${entry.name} ${entry.description}`.toLowerCase()
          if (terms.every((term) => haystack.includes(term))) selected.set(entry.key, entry)
        }
      }

      if (selected.size === 0) {
        return {
          title: "mcp_search",
          metadata: { matches: 0 },
          output: "No matching MCP tools found.",
        }
      }

      // want -> the disclosure tier. "schema" discloses the input schema without
      // the description; the catalog format keys off McpTier, so map it there.
      const want = params.want ?? "full"
      const tier: "description" | "full" = want === "description" ? "description" : "full"

      const matches = [...selected.values()].sort((a, b) => a.key.localeCompare(b.key))
      const rendered = matches.map((entry) => {
        const full = McpCatalog.renderTool(entry, tier)
        if (want === "schema") return { name: full.name, input_schema: entry.schema }
        return full
      })

      return {
        title: "mcp_search",
        metadata: { matches: matches.length },
        output: JSON.stringify(rendered, null, 2),
      }
    },
  }
})
