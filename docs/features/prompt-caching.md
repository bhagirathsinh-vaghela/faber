# Prompt caching

Faber keeps every byte in front of the conversation identical across turns, sessions, repositories, plan/build switches, keep-warm pings and compaction, so Anthropic's prompt cache keeps hitting. Across 176,856 Anthropic requests between July and October 2026, about 99% of input tokens (99.05%) were served from cache, measured as cache reads divided by uncached input plus cache reads plus cache writes. The first part of this work is upstream OpenCode [PR #14743](https://github.com/anomalyco/opencode/pull/14743).

> **Provider scope.** Cache markers are placed only for Claude models, whether served by Anthropic or by another provider whose model id names Claude, such as Bedrock or OpenRouter (`ProviderTransform.message` in `provider/transform.ts`). The four breakpoints and the 5-minute and 1-hour lifetimes are Anthropic's. Providers with automatic prefix caching (OpenAI, Gemini) still benefit from the byte-stable prefix, but nothing on this page controls their cache.

## How it works

Anthropic hashes a request in a fixed order: `tools`, then `system`, then `messages`. A cache entry is keyed by the cumulative hash of everything up to a `cache_control` marker, and the API allows four markers per request. Any byte that changes early in that order (a tool description that embeds the working directory, today's date, a reordered tool list) invalidates every entry behind it. Faber arranges the request so that stable content comes first and never moves, then places the four markers where they buy the most reuse.

### System blocks, in stability order

`LLM.stream` builds three system blocks:

| Block | Contents                                                                                | Marker |
| ----- | --------------------------------------------------------------------------------------- | ------ |
| S1    | Provider prompt and global instructions                                                 | 1h     |
| S2    | Environment block, project instructions, any per-message system text                    | 1h     |
| S3    | `<session_context>`: session-start date and git branch, plus the question-tool guidance | none   |

S1 is identical across repositories, so one cache entry serves every project on a machine. S2 holds only what is stable for a directory: working directory, whether it is a git repo, platform, architecture and shell (`SystemPrompt.environment`).

Values that turn over on their own live in S3, which sits after both 1h markers and before the conversation. The marker selector recognises S3 by its `<session_context>` tag (`isSessionContext`) and never marks it, so a new day or a new branch leaves both 1h entries intact. `SystemPrompt.sessionBlock` always assembles S3 so that it opens with that tag, which keeps a caller from producing an untagged block that would read as markable.

S3 is written once per session and frozen: the date and branch come from the session record (`session.time.created`, `session.branch`), not from the clock or `git`. When either moves later, a `<session_context_update>` block is appended at the tail of the conversation instead of rewriting S3 (see [turn reminders](turn-reminders.md)).

A plugin may prepend its own block through the `experimental.chat.system.transform` hook. It lands ahead of S1 and is covered by the 20-block lookback of S1's marker.

### Conversation markers

`selectCacheMarkers` in `provider/transform.ts` assigns the remaining two markers, both with a 5-minute TTL:

| Marker | Position                                                                                                                      | Purpose                                                                                         |
| ------ | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 3      | The last assistant message before the current typed prompt (the end of the previous turn). On a first turn, the typed prompt. | A stable checkpoint at the turn boundary for the whole turn.                                    |
| 4      | The newest message, or a one-shot probe target (see [cache-safe revert](cache-safe-revert.md)).                               | Moves forward with every API call, so each step of a tool loop reads the previous step's entry. |

Anthropic looks back up to 20 blocks from each marker for a hit. The docstring on `cacheMarkerIndices` works through an example: with markers at `[0, 1, 150, 180]`, marker 150 stays fixed for the turn while 180 slides with each call.

A single call whose messages are never re-sent (for example a one-shot judge request) uses the `"system"` cache scope instead: one 1h marker on the last system block and none on the messages, which would pay for a write that is never read (`ProviderTransform.Cache`).

### A byte-identical `tools[]`

`tools[]` is the first thing hashed, so it gets the strictest treatment:

- `ToolRegistry.all` sorts every tool by id. Custom tools come from filesystem globbing, whose order depends on the OS.
- The bash tool's description carries no working directory.
- The skill tool lists skill locations relative to the session's directory or to `~/` when the skill lives under one of them (`relativePath` in `tool/skill.ts`). Instruction file headers follow the same rule (`formatPath` in `session/instruction.ts`), so two checkouts of one repo, or two users, render the same bytes.
- The Anthropic web search tool carries no date in its description; the date reaches the model through S3.
- Repository-scoped subagents are announced in conversation history (`insertAgentCatalog`) instead of in the agent tool's description.
- Plan and build mode send the same schema: plan-mode restrictions are enforced when a tool executes (`SessionPrompt.allowlist`, `SessionPrompt.toolDenial`), and the mode-switch tools stay on the wire for every agent. A tool an agent's permission disables outright is left out of `tools[]` (`SessionPrompt.resolveTools`).
- MCP tools listed in the session's MCP catalog are kept out of `tools[]` on Anthropic requests through `activeTools`, so toggling an MCP server mid-session does not rewrite the prefix. They stay registered, so a call to one still runs.

### Secondary requests share the prefix

Compaction, keep-warm pings and subagents build their requests through the same path as a normal turn:

- Compaction resolves the session's own agent (`SessionPrompt.resolveAgent`), the same tools and the same system blocks. The summarisation instruction rides in the trailing user message, and `allowedTools: []` disables every tool at execution time without removing it from the schema (`session/compaction.ts`).
- A keep-warm ping rebuilds the exact turn request and appends a one-character user message (see [keep-warm](keep-warm.md)).
- A subagent keeps the agent tool in its schema and is told in conversation that it cannot delegate, rather than having the tool removed.

### Debugging a miss

Every Anthropic request logs a `cache markers` line with the marker indices and the sha256 and length of each marked system block. Setting `OPENCODE_CACHE_DEBUG` also logs `CACHE_PREFIX_HASH_V1` (hashes of `tools[]`, the first system block and both together) and `CACHE_TOOL_HASHES_V1` (one hash per tool), which pinpoints the tool or block that drifted between two requests.

## Configuration

Caching is automatic. It applies to Anthropic and Claude models, including Claude served through Bedrock, OpenRouter or an OpenAI-compatible gateway, each with its own marker syntax. Related keys:

| Key                                  | Effect                                                                                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instructions`                       | Extra instruction files; global ones land in S1, project ones in S2.                                                                                       |
| `concise`                            | Opts a model into the per-turn concise reminder, which rides the conversation tail rather than the system prompt. See [turn reminders](turn-reminders.md). |
| `ping.enabled`, `ping.before_expiry` | The keep-warm daemon. See [keep-warm](keep-warm.md).                                                                                                       |

## Why

The design follows from the hashing order. The commit that sorted the tool list states it directly: "Anthropic's prompt cache hashes the request in strict order: tools -> system -> messages ... Any change to tools[] invalidates the entire downstream cache."

Specific choices and the problems that produced them, from commit messages:

- **Date and branch moved out of the 1h blocks.** The date turned over at midnight and the branch on every checkout, both at a fixed width, "so the churn hid while it broke cross-session sharing daily". The question-tool fragment shipped only when a session allowed the tool, so a subagent and a normal session in the same directory produced different S2 blocks. The web search tool spliced the current month into its description, which "invalidated the whole prefix machine-wide once a month".
- **Marker 3 on the previous turn's last assistant.** An agentic turn can run for hours of tool calls, and the useful undo point is the turn boundary. Pinning the stable marker there keeps "undo this turn" or "edit this prompt" a cache hit for the whole turn, while the rolling marker still caches the tool loop.
- **Compaction on the turn's prefix.** Compaction once sent `tools: {}` and `system: []`, a full miss on about 200k tokens ("~$0.54 wasted per compaction"). Later a dedicated compaction agent's prompt replaced the first system block, giving "0 cache read and a full rewrite on the largest request in the session". Resolving through the session's own agent took the cache read from 0 to 48k at about 48k context.
- **Frozen environment.** The date and branch were recomputed on every call, so "every midnight rollover or mid-session `git checkout` mutated the block". The web UI's status line still shows the live branch; only the model's copy is frozen.

## Code

- `packages/opencode/src/provider/transform.ts`: `selectCacheMarkers`, `applyCaching`, `cacheMarkerIndices`, `isSessionContext`, `ProviderTransform.message`
- `packages/opencode/src/session/llm.ts`: `LLM.stream` (system block assembly, `activeTools`, probe index resolution, `CACHE_PREFIX_HASH_V1`)
- `packages/opencode/src/session/system.ts`: `SystemPrompt.environment`, `SystemPrompt.sessionContext`, `SystemPrompt.sessionBlock`, `SESSION_CONTEXT_MARKER`
- `packages/opencode/src/session/instruction.ts`: `InstructionPrompt.system`, `formatPath`
- `packages/opencode/src/tool/registry.ts`: `ToolRegistry.all`
- `packages/opencode/src/tool/skill.ts`: `relativePath`
- `packages/opencode/src/session/compaction.ts`: the compaction request built on `SessionPrompt.resolveTools`
- `packages/opencode/src/session/prompt.ts`: `resolveTools`, `toolDenial`, `insertAgentCatalog`, `insertSessionContext`
