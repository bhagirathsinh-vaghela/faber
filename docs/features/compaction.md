# Compaction

When a conversation nears the model's context limit, Faber summarizes it and continues from the summary. Auto-compaction fires at a configurable share of the context window. The summarizing request reuses the session's own agent, model, tools and system blocks, so it is a cache read rather than a full prefix rewrite. The summary follows a fixed structure that keeps decisions, rejected alternatives and exact identifiers. Afterwards the model is nudged to continue whatever it was doing.

> **Provider scope.** Compaction works with every model. The cache-safe parts, such as the summary request reusing the session's cached prefix, pay off where Faber places cache markers, which is Claude models.

## How it works

### When it fires

After each step, `SessionCompaction.isOverflow` compares the step's token count (input + cache read + output) with a limit:

```text
usable = model.limit.input, or context - min(model output limit, OUTPUT_TOKEN_MAX)
limit  = threshold ? min(context * threshold, usable) : usable
```

The usable window always caps the threshold, so a fraction set too high still compacts before the API would reject the request. A summary message never triggers the next compaction, since its usage measures the history it just replaced. When the limit is crossed, the prompt loop writes a compaction part (`SessionCompaction.create`) and runs it before the next step.

Manual compaction (`/compact` in the web UI, `POST /session/:sessionID/summarize`) writes the same part and takes the same path.

### Same prefix as a normal turn

`SessionCompaction.process` builds the summarizing request from the same pieces a normal turn uses:

| Piece                   | Source                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| Agent and system prompt | The session's real agent (build or plan), not a dedicated compaction agent                        |
| Model                   | The model of the user message being answered                                                      |
| `tools[]`               | `SessionPrompt.resolveTools` with the session's own tools                                         |
| System blocks           | Environment, global and project instructions, session context, from the session's pinned snapshot |
| Messages                | The full conversation, then one trailing user message carrying the summary instruction            |

Tools are disabled for this call with an empty runtime allowlist (`allowedTools: []`), which rejects any call at execution time without removing a tool from the schema. The instruction tells the model that tool calls will be denied and to answer in plain text. Because only the trailing message differs, the request reads the conversation from the prompt cache.

### The summary

The default instruction asks for nine numbered sections:

1. Primary request and intent
2. Key technical concepts
3. Files and code, always by exact path, with exact branch, PR and ticket identifiers
4. Errors and fixes, including user feedback on them
5. Decisions and rejected alternatives, with reasons
6. Problem solving
7. Pending tasks vs open threads
8. Current work
9. Next step, with a verbatim quote of where things left off

A plugin can add context or replace the prompt through the `experimental.session.compacting` hook.

### After the summary

Once the summary is written, one synthetic message is added to the turn:

- `Continue if you have next steps`, sent after every compaction, automatic or manual;
- a reminder that files read before the summary are no longer in context and must be read again before editing, since the read-before-edit check would otherwise refuse the edit.

The session's stored MCP catalog text is also cleared, so the next turn re-injects the catalog into the new context (see [MCP progressive disclosure](mcp-progressive-disclosure.md)).

### Pruning

Separately from compaction, at the end of each prompt loop `SessionCompaction.prune` walks back through completed tool calls older than the last two turns. It keeps the newest 40,000 tokens of tool output (`PRUNE_PROTECT`) and, if more than 20,000 tokens (`PRUNE_MINIMUM`) lie beyond that, marks those outputs as compacted so they are no longer sent. Output from the `skill` tool is never pruned. Pruning stops at the previous summary.

## Configuration

| Key                    | Default            | Meaning                                                                                                  |
| ---------------------- | ------------------ | -------------------------------------------------------------------------------------------------------- |
| `compaction.auto`      | `true`             | Compact automatically when the limit is reached                                                          |
| `compaction.prune`     | `true`             | Prune old tool outputs                                                                                   |
| `compaction.threshold` | full usable window | Fraction of the context window (0 to 1) that triggers compaction, e.g. `0.9` compacts a 1M model at 900k |

The environment variables `OPENCODE_DISABLE_AUTOCOMPACT` and `OPENCODE_DISABLE_PRUNE` force `auto` and `prune` off.

```json
{
  "compaction": { "threshold": 0.85 }
}
```

## Why

- **Configurable threshold.** On a 1M-context model the old trigger fired at 968k, which left no room to summarize before the next request would be rejected.
- **Same prefix.** Anthropic caches on a cumulative prefix hash; a dedicated compaction agent's prompt replaced the first system block and invalidated the whole cached prefix, giving a 0% hit on the largest request in the session (`SessionCompaction.process` comment). The summary instruction moved to the trailing message, and tools are blocked at runtime instead of removed.
- **Structured summary.** Inspired by Claude Code's compaction summary. Keeping errors, user corrections and rejected alternatives stops the next context from retrying a path that was already ruled out.
- **Nudge after every compaction.** The model decides from its own summary whether anything is left to continue, rather than the server guessing whether compaction interrupted work.
- **Reads reminder.** Delivered on the nudge because that is the first thing the model sees after a summary (`COMPACTION_READS` comment).

## Code

- `packages/opencode/src/session/compaction.ts`: `SessionCompaction.isOverflow`, `SessionCompaction.process`, `SessionCompaction.prune`, `SessionCompaction.create`, `CONTINUE_NUDGE`, `COMPACTION_READS`
- `packages/opencode/src/session/processor.ts`: overflow check after each step
- `packages/opencode/src/session/prompt.ts`: compaction trigger in the prompt loop
- `packages/opencode/src/server/routes/session.ts`: `/:sessionID/summarize`
- `packages/opencode/src/config/config.ts`: `compaction` schema
