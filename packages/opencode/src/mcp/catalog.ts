import type { Config } from "../config/config"
import type { MCP } from "./index"
import type { ModelMessage } from "ai"

// Progressive-disclosure catalog formatting. Shared by the steady-state
// catalog block and the mcp_search disclosure tool, so both render a tool
// identically at a given tier and the bytes stay stable.
export namespace McpCatalog {
  // What a tier attaches to a tool name. Names are always the floor — the
  // model must see every name to know what to ask mcp_search for — so the
  // tier only controls the *attached* detail (description, schema).
  const TIER_RANK: Record<Config.McpTier, number> = { name: 0, description: 1, full: 2 }

  export function atLeast(tier: Config.McpTier, floor: Config.McpTier) {
    return TIER_RANK[tier] >= TIER_RANK[floor]
  }

  // One tool rendered at a given tier. `name` is always present; `description`
  // is attached at description+ ; `input_schema` at full. Field order is fixed
  // (name, description, input_schema) for byte-stable output.
  export function renderTool(entry: MCP.CorpusEntry, tier: Config.McpTier) {
    const out: { name: string; description?: string; input_schema?: unknown } = { name: entry.key }
    if (atLeast(tier, "description")) out.description = entry.description
    if (atLeast(tier, "full")) out.input_schema = entry.schema
    return out
  }

  // The steady-state <mcp_tool_catalog> block text. Grouped by server, servers
  // sorted alphabetically, tools sorted alphabetically within each server, so
  // the block is byte-identical across every session with the same MCP set and
  // tiers (the shared-cache invariant). Each server renders at its configured
  // tier; names are always the floor. Returns undefined when there are no MCP
  // tools (nothing to list).
  export function build(entries: MCP.CorpusEntry[]): string | undefined {
    if (entries.length === 0) return undefined

    const byServer = new Map<string, MCP.CorpusEntry[]>()
    for (const entry of entries) {
      const list = byServer.get(entry.client) ?? []
      list.push(entry)
      byServer.set(entry.client, list)
    }

    const servers = [...byServer.keys()].sort((a, b) => a.localeCompare(b))
    const groups = servers.map((server) => {
      const tools = byServer
        .get(server)!
        .slice()
        .sort((a, b) => a.key.localeCompare(b.key))
      // Server tier is uniform across its tools (per-server config), so read it
      // off the first entry.
      const tier = tools[0].tier
      return {
        server,
        tier,
        tools: tools.map((tool) => renderTool(tool, tier)),
      }
    })

    return "<mcp_tool_catalog>\n" + INSTRUCTION + "\n" + JSON.stringify(groups) + "\n</mcp_tool_catalog>"
  }

  const INSTRUCTION =
    "You have access to these additional tools, grouped by server. Call them with standard tool_use blocks using the names below. " +
    "When a tool lists no description or input schema here, call the mcp_search tool to retrieve it before using the tool."

  // Every tool name a catalog block in these messages lists. A session can carry
  // more than one block (a later one is appended when the MCP set changes), and a
  // name the model has seen in any of them stays callable. Only a block with
  // build()'s own instruction line counts, and one whose list does not parse is
  // skipped: the text can also be something a user pasted.
  export function listed(messages: ModelMessage[]) {
    const names = new Set<string>()
    const opening = "<mcp_tool_catalog>\n" + INSTRUCTION + "\n"
    for (const message of messages) {
      if (message.role !== "user") continue
      const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content
      for (const part of parts) {
        if (part.type !== "text") continue
        for (const chunk of part.text.split(opening).slice(1)) {
          const end = chunk.indexOf("\n</mcp_tool_catalog>")
          if (end < 0) continue
          for (const name of groupNames(chunk.slice(0, end))) names.add(name)
        }
      }
    }
    return names
  }

  function groupNames(json: string): string[] {
    const groups = (() => {
      try {
        return JSON.parse(json) as unknown
      } catch {
        return undefined
      }
    })()
    if (!Array.isArray(groups)) return []
    return groups.flatMap((group) =>
      Array.isArray(group?.tools)
        ? group.tools.flatMap((tool: { name?: unknown }) => (typeof tool?.name === "string" ? [tool.name] : []))
        : [],
    )
  }
}
