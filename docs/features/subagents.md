# Subagents

The `agent` tool launches a subagent in the background and returns immediately, so the parent keeps working. The subagent runs with the parent's exact agent, model and tool list, so its first request starts on a prompt-cache hit instead of a cold prefix. What it may actually do is restricted at execution time by a named tool preset. It can optionally inherit the parent's whole conversation. Its result arrives in the parent as a card once the subagent and everything it started have gone quiet.

## How it works

### Launch

A subagent is a child session (`parentID` set to the caller). `AgentTool.execute`:

1. Refuses if the caller is itself a subagent: nesting is one level deep, and the tool says so.
2. Resolves the `toolset` preset and stamps its tool list onto the child session as `allowedTools`.
3. With `include_context: true`, copies the parent's conversation into the child (`Session.copy`).
4. Sends the prompt with the parent's model and variant, and with the parent's agent (not the `subagent_type`).
5. Returns at once with a confirmation and a `<system-reminder>` telling the parent it is the orchestrator for this task, that the result will arrive as a new user-turn message, and that doing the work itself would produce output that conflicts with the real result.

Passing `session_id` continues an existing child of the same parent. A prompt sent to a child that is still running joins its current work, and the child reports once for both.

### Cache parity

Anthropic caches on a prefix that starts with `tools[]` and the system blocks. If a subagent used its own agent prompt or a trimmed tool list, every subagent would cold-start. Faber keeps the child's agent, model, system prompt and tool schema identical to the parent's and enforces the preset at execution time instead: `SessionPrompt.toolDenial` rejects any call to a tool not in `allowedTools`, returning the list of tools that are available. The schema the model sees never changes.

### Tool presets

`toolset` is a required parameter on every call. The built-in presets (`Agent.toolsets`):

| Preset        | Tools                                                                         |
| ------------- | ----------------------------------------------------------------------------- |
| `explore`     | grep, glob, list, bash, read, todowrite, webfetch, websearch, codesearch, lsp |
| `general`     | the `explore` set plus write, edit, apply_patch, multiedit, skill             |
| `explore-mcp` | `explore` plus `mcp_search` and read-only MCP tools                           |
| `general-mcp` | `general` plus `mcp_search` and every MCP tool                                |

MCP access uses two sentinels: `mcp:read` grants an MCP tool only when its server advertises `readOnlyHint: true`; `mcp:write` grants every MCP tool. `question` is in no preset: a subagent has no human to answer it, so a question would leave it waiting forever.

### Result delivery

Every message into a child opens a debt row owed to the parent, or joins the one still open (see [restart recovery](restart-recovery.md)). `Recovery` pays it once the child is done: no turn running, no turn marker, nothing still owed to it (including its own background jobs), and no message waiting. The result is delivered as a `<background-subagent-result>` synthetic user message inside the same transaction that removes the debt, so it lands exactly once across restarts. If the parent is mid-turn, the result joins that turn.

A Stop on a subagent delivers a stopped notice telling the parent it can continue the child with its `session_id`.

### UI

| Surface                      | Detail                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| Launch card                  | Description, summary, preset and its tools, whether parent context was copied       |
| Result card                  | The subagent's final output, labelled with its description                          |
| Subagents dialog (Alt+A)     | The session's children, running above completed; Ctrl+Tab switches between siblings |
| `GET /background?sessionID=` | A session's subagents with their status and progress                                |

## Configuration

| Key                 | Meaning                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `subagent_toolsets` | Map of preset name to allowed tool ids. Merged over the built-in presets; config wins on a name collision |

```json
{
  "subagent_toolsets": {
    "docs": ["read", "grep", "glob", "write", "edit"]
  }
}
```

## Why

- **Cache parity.** Using the parent's agent, model and full tool list makes the child's system prompt and tool prefix match the parent's, so it hits the prompt cache from its first call instead of cold-starting each subtask (`Agent.toolsets` comment and the commit that introduced it). Restrictions therefore move to execution time.
- **Presets.** Without them a delegation meant to be read-only could still write files.
- **No result tag in the tool text.** When the result block's tag name appeared in the tool's own output, the model wrote fake result blocks; the tag now appears only in the real delivery.

## Code

- `packages/opencode/src/tool/agent.ts`: `AgentTool`
- `packages/opencode/src/agent/agent.ts`: `Agent.toolsets`, `BUILTIN_TOOLSETS`, `MCP_READ`, `MCP_WRITE`
- `packages/opencode/src/session/prompt.ts`: `SessionPrompt.toolDenial`, `SessionPrompt.allowlist`
- `packages/opencode/src/session/recovery.ts`: `Recovery.done`, `Recovery.subagents`, subagent result delivery
- `packages/opencode/src/server/routes/background.ts`: `BackgroundRoutes`
- `packages/app/src/components/dialog-subagents.tsx`, `packages/app/src/components/subagents-button.tsx`
