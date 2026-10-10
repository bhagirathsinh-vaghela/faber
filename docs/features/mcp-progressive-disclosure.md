# MCP progressive disclosure

MCP servers can add tens of thousands of tokens of tool schemas to every request. Faber instead shows the model a compact catalog of every MCP tool (names only by default) and lets it pull a description or input schema on demand with the `mcp_search` tool. The catalog is injected once into the conversation as durable history and is byte-identical across sessions that share the same servers and settings, so it stays inside the cached prompt prefix. Arguments the model emits without having seen a schema are coerced back to the declared types before the call.

> **Provider scope.** The compact catalog is shown to every model, but leaving catalogued MCP tools out of `tools[]` happens only for the `anthropic` provider (`McpCatalog.listed` in `session/llm.ts`). Claude served through another provider, and every other model, still receives every MCP tool schema.

## How it works

### The catalog block

`McpCatalog.build` renders every enabled MCP tool into one `<mcp_tool_catalog>` block:

- grouped by server, servers sorted alphabetically, tools sorted within each server;
- each server rendered at its configured tier: `name` (just the tool name), `description` (adds the description), or `full` (adds the input schema);
- preceded by one instruction line telling the model to call `mcp_search` when a tool shows no description or schema.

Fixed ordering and field order make the block byte-identical for the same set of servers and tiers.

### Injection, once

`SessionPrompt.insertMcpCatalog` runs every turn but rarely writes anything. Each session stores the catalog text it last injected (`mcpCatalogText`):

| Current catalog vs stored | Action                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------- |
| Equal                     | Nothing (the common case)                                                              |
| Different, now empty      | Store `""`, append nothing                                                             |
| Different, non-empty      | Append a fresh full block as a synthetic part on the latest user message, and store it |

An older block is never edited; the newest one supersedes it and the old one stays as inert history. After compaction, the stored text is cleared so the next turn re-injects a block into the new context. Config changes take effect when a session is stopped and reopened, which re-reads config and resets MCP state.

### Keeping schemas out of `tools[]`

For the Anthropic provider, `LLM.stream` leaves every MCP tool that a catalog block in the conversation lists out of `tools[]`, along with any tool a server's `disabled` list names. The tools stay registered, so a call to one still executes. Other providers are sent every tool, since only the Anthropic API accepts a `tool_use` whose name is not in `tools[]`.

### `mcp_search`

`mcp_search` returns detail for MCP tools by exact key (`select`), by keyword match across names and descriptions (`query`), or both. `want` picks `description`, `schema` or `full` (default). Search covers every enabled tool regardless of tier. The result stays in history, so the model does not need to search for the same tool twice. The tool is registered whenever at least one MCP server is configured.

### Argument coercion

A model calling a tool it only knows by name often sends `"17"` for a number, `"true"` for a boolean, or an array as a JSON string (`"[\"UNREAD\"]"`). `MCP` holds the real schema, so `coerceArgs` converts string-encoded numbers, booleans and arrays back to the declared types before the call. Other values pass through unchanged.

### Hiding tools

Every tool a server advertises is available by default. A tool named in the server's `disabled` list is dropped from the catalog and denied at execution (`mcpDenied`). Because the list lives with the server config, a project config can hide a different set than the global config for the same server.

### Transport and stability

| Behaviour                   | Detail                                                                                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool list cached per client | `listTools()` is called once when the client is created, so the catalog survives token rotation, network blips and server restarts; tools a server adds mid-session appear after a reconnect |
| Long calls                  | Calls send a progress token and reset their timeout on progress, so a tool that reports progress can run past the default timeout                                                            |
| Read-only hint              | `MCP.readOnly` reports a tool as read-only only when its server advertises `readOnlyHint: true`; subagent presets and plan mode use this                                                     |

### Inspecting what the model sees

| Surface                             | Detail                                                     |
| ----------------------------------- | ---------------------------------------------------------- |
| MCP button in the prompt action bar | Opens a read-only viewer of the corpus (`GET /mcp/corpus`) |
| `opencode mcp tools <name>`         | Lists a server's tools from the CLI                        |

## Configuration

Per server, under `mcp.<name>`:

| Key        | Default                   | Meaning                                                                   |
| ---------- | ------------------------- | ------------------------------------------------------------------------- |
| `tier`     | `name`                    | Catalog detail: `name`, `description` or `full`. Applies to every session |
| `disabled` | none                      | Tool names to hide from the catalog and deny at execution                 |
| `timeout`  | 30000 ms connect and list | Timeout in ms for connecting, listing tools and each tool call            |

Global:

| Key                                                          | Meaning                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `experimental.mcp_timeout`                                   | Tool-call timeout in ms when the server sets none (the MCP SDK default is 60000)            |
| `experimental.mcp_oauth_port`, `experimental.mcp_oauth_path` | Fixed callback for remote MCP servers using OAuth (defaults `19876`, `/mcp/oauth/callback`) |

```json
{
  "mcp": {
    "example": {
      "type": "local",
      "command": ["example-mcp-server", "--stdio"],
      "tier": "description",
      "disabled": ["delete_everything"]
    }
  }
}
```

## Why

- **Byte-stable catalog.** The block is identical across every session with the same MCP set and tiers, which is what lets sessions share the cached prefix (`McpCatalog.build` comment). Tier is therefore per server and never per session.
- **Not in `tools[]`.** `tools[]` sits ahead of every cache marker, so an MCP server toggled mid-session would rewrite the whole cached prefix (`LLM.stream` comment).
- **Always on, hide by config.** An earlier version made MCP opt-in per session and kept a names-only whitelist. Both were dropped: every advertised tool is in by default, and hiding moved to the `disabled` config list.
- **Coercion.** Without it, stringly-typed arguments from a model that never saw the schema were rejected by the server's own validation, and array-taking tools broke.
- **Cached tool lists.** A snapshot taken at connect keeps the catalog stable through token blips, network blips and server restarts; picking up mid-session tool changes only on reconnect is the accepted cost (`MCP` tools cache comment).

## Code

- `packages/opencode/src/mcp/catalog.ts`: `McpCatalog.build`, `McpCatalog.renderTool`, `McpCatalog.listed`
- `packages/opencode/src/mcp/index.ts`: `MCP.corpus`, `MCP.isDisabled`, `MCP.readOnly`, `coerceArgs`
- `packages/opencode/src/tool/mcp-search.ts`: `McpSearchTool`
- `packages/opencode/src/session/prompt.ts`: `insertMcpCatalog`, `mcpDenied`
- `packages/opencode/src/session/llm.ts`: MCP tools left out of `tools[]`
- `packages/opencode/src/server/routes/mcp.ts`: `/corpus`
- `packages/app/src/components/dialog-mcp-corpus.tsx`
