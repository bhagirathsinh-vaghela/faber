# Features

Everything Faber adds on top of upstream OpenCode, grouped by area. Each entry links to a page with how it works, configuration, and code pointers.

## Prompt caching and cost

**Prompt caching.** Faber keeps every byte in front of the conversation identical across turns, sessions, repos, plan/build switches, keep-warm pings and compaction, so Anthropic's prompt cache keeps hitting. Stable content comes first, the four allowed cache markers sit where they buy the most reuse, and secondary requests reuse the session's own prefix. About 99% of Anthropic input tokens are served from cache (99.05% over 176,856 requests, July to October 2026). [Details](docs/features/prompt-caching.md)

**Keep-warm.** A per-session daemon re-sends the cached prefix a few seconds before Anthropic's 5-minute cache expires, so a session waiting on you, a long tool call or a slow model step resumes on a cache hit. The ping persists no message and runs no tools. It arms when you send in or open a session and disarms on Stop, archive or delete; the intent survives restarts. Off by default (`ping.enabled`). [Details](docs/features/keep-warm.md)

**Session pinning.** A running session's instructions, agents, commands and skill catalog are frozen for its lifetime, so editing config or `AGENTS.md` never rewrites a live session's cached prefix. New sessions always see current disk; Stop then reopen picks up changes. Snapshots are content-hashed and shared between sessions that see the same files. [Details](docs/features/session-pinning.md)

**Cache-safe revert.** "Revert here" first re-seeds the cache entry for the conversation up to the message you return to, then reverts. Dropping a tangent or retrying from an earlier point continues on a full cache hit, even if that entry had expired. [Details](docs/features/cache-safe-revert.md)

**Turn reminders.** Rules are restated where the model reads them without breaking the cache. Injected reminders (concise style, plan mode, question-tool rule, subagent no-delegation note, skill checklist, date or branch change, MCP catalog change) is appended to the turn's opening message, and a write onto an already-sent message is refused. [Details](docs/features/turn-reminders.md)

**Usage and cost.** Per-message and per-session token, cache and dollar figures are computed on the server, with cache writes priced by TTL (1h at 2x, 5m at 1.25x) and prices overridable in config. They show as a customizable chip row in the dock and under each answer, with one layout shared by every client. [Details](docs/features/usage-and-cost.md)

## Agents that keep working

**Background jobs.** Every shell command runs as a durable job. One that finishes within a grace window returns inline; one that runs longer hands back a job id and reports its result into the session when it ends, even across a server restart. The model never has to guess how long a command will take, and a `/jobs` page shows live logs. [Details](docs/features/background-jobs.md)

**Subagents.** The agent tool always launches subagents in the background, with the parent's system prompt and tool list so they start on a cache hit. A subagent can inherit the parent conversation, and a named tool preset restricts what it may do. Results arrive as cards once the subagent and its jobs go quiet. [Details](docs/features/subagents.md)

**Restart recovery.** One database ledger records every result a session is owed (a subagent's answer, a job's output), and one collector pays each exactly once. After a restart or reboot, interrupted turns resume, subagents come back with their parent, and warm sessions are re-armed. A small supervisor process restarts the server behind a health check. [Details](docs/features/restart-recovery.md)

**MCP progressive disclosure.** For Anthropic models, the model sees a compact, byte-stable catalog of every MCP server's tools (names only by default) and pulls descriptions or schemas on demand with `mcp_search`, instead of carrying every schema in every request. Tiers and hidden tools are set per server in config. Transport and argument-coercion fixes make large MCP servers usable. [Details](docs/features/mcp-progressive-disclosure.md)

**Question tool.** When the model needs a decision, it asks through a picker you can click or answer in your own words, from any client. Answered questions are stored as your own message, which keeps the model asking with the tool instead of typing look-alike questions in prose. [Details](docs/features/question-tool.md)

**Compaction.** Auto-compaction triggers at a configurable share of the context window and reuses the session's cached prefix and model instead of paying a full rewrite. It writes a structured summary that keeps decisions, errors and exact paths, then nudges the model to continue the work it interrupted. [Details](docs/features/compaction.md)

**Plan mode.** Switching between plan and build no longer costs a cache miss: the tool list never changes, and plan mode scopes edits to plan files when a tool runs. Read-only MCP tools stay available while planning. The model can propose entering or leaving plan mode itself, and a typed reply to that proposal is honoured. [Details](docs/features/plan-mode.md)

**Turn parameters.** Every turn runs under one agent, model and variant chosen at its start and stored on the session, so injected results, compaction and restarts never silently switch the model or mode. Picks made in a browser tab apply only when you send from it. [Details](docs/features/turn-parameters.md)

**Tool upgrades.** Exact-match editing that preserves encodings and line endings, read tracking that survives restarts and compaction, and de-duplicated re-reads. Richer grep, glob, webfetch and websearch output, PDF page ranges, LSP lookups by symbol name, `~` expansion in paths, and a host check on every webfetch redirect hop. [Details](docs/features/tool-upgrades.md)

**Headless APIs.** `POST /agent/headless` runs an agent to completion with nobody attached and returns the final message, usage, cost and refused permissions. `POST /oneshot` makes a single model call with no session, optionally streamed. Both let other apps use Faber as a backend. [Details](docs/features/headless-api.md)

**Plugin judge.** A plugin can ask a model to check one artifact against one rule, with none of the session's context, prompts or tools. It is meant for enforcing rules at the tool boundary, and fails open on infrastructure errors. [Details](docs/features/plugin-judge.md)

**Skills and config.** Reference skills inline with `[USE-SKILL:name]` markers and favorites, and let skills declare their own reminders in frontmatter. Layer per-machine `AGENTS.local.md` and `opencode.local.json` over committed files. A model's config block is authoritative for its own fields (limits, variants, pricing) when models.dev is wrong or missing. [Details](docs/features/skills-and-config.md)

## Web UI for many sessions, any device

**Session overview.** One server-owned list of your recent sessions (500 by default, starred ones kept beyond that), with live sections for working and attention-needing sessions and a notification center. Ctrl+Tab switches sessions like Alt+Tab, and stop, rename, star and undoable archive work from the list. Every client sees the same state. [Details](docs/features/session-overview.md)

**Transcript.** Every block the API returns is its own numbered card (text, thinking, each tool call and result), coloured by kind. Markdown streams without flicker, chat supports callout blocks, older steps collapse, and a virtualized list keeps very long sessions light on phones. Machinery injected for the model is hidden behind a debug switch. [Details](docs/features/transcript.md)

**Reader mode.** A read-first layout hides the composer and chrome so the transcript fills the screen. A small frosted pill brings back the composer or the mic, any typed key lands in the composer, and the choice is remembered per session. [Details](docs/features/reader-mode.md)

**Mobile and PWA.** The web UI installs as an app on desktop, iPhone, iPad and Android. Controls are sized by pointer (finger or mouse) rather than window width, the layout survives the soft keyboard and collapsing URL bars, and every control acts on the first tap. [Details](docs/features/mobile-and-pwa.md)

**Voice.** Dictate into the composer or a question from any device, with pause and resume, a live transcript, and recovery if the connection drops. Any answer or thinking card can be read aloud, first rewritten into natural speech by a model, then streamed in chunks. Speech runs on a local sidecar you provide. [Details](docs/features/voice.md)

**Real-time sync.** Many clients stay live on one server over flaky networks. Text streams as coalesced deltas, each client subscribes only to the sessions it shows, reconnects heal missed messages, questions and permissions, and a session paints from an on-device snapshot before the network answers. [Details](docs/features/realtime-sync.md)

**Alert sounds.** Distinct sounds for a finished turn, a turn that needs you, an error, and stop, archive or delete. Each fires once per event, and "done" plays only when the session has truly gone quiet with no subagent or job still running. A titlebar bell mutes the client. [Details](docs/features/alert-sounds.md)

**Appearance.** Named themes over the built-in bases with per-box colours, fonts that offer only the weights they ship (continuous weight for variable fonts), GitHub-palette diffs, dark by default, and frosted-glass popovers. Settings are stored on the server and shared by every client. [Details](docs/features/appearance.md)

**Projects and worktrees.** A project is a directory: each git worktree or subfolder gets its own rail tile. The open-project list is shared across every client and survives restarts, and the branch chip shows the working tree's lines added and removed. [Details](docs/features/projects-and-worktrees.md)

## Platform

**SQLite storage.** Sessions, messages and parts live in one WAL SQLite database instead of hundreds of thousands of JSON files. Writes are atomic, two servers can share the store during a restart, and ids stay monotonic across clock changes and restarts so ordering never breaks. [Details](docs/features/sqlite-storage.md)

## Removed from upstream

| Removed                                                         | Notes                                                            |
| --------------------------------------------------------------- | ---------------------------------------------------------------- |
| Terminal UI                                                     | The web UI is the only interface.                                |
| CLI commands `run`, `web`, `acp`, `github`, `pr`, `debug agent` | No caller once the web UI was the only client.                   |
| Non-English locales                                             | English only.                                                    |
| Session sharing                                                 | Removed.                                                         |
| Anthropic subscription login                                    | Anthropic is reached with an API key, like every other provider. |
| Install script and `opencode upgrade`                           | Faber is built from source.                                      |
| Docs site                                                       | Documentation lives in this repo.                                |
| Desktop app                                                     | The web UI installs as a PWA instead.                            |

## Reference

- [Supervisor](docs/supervisor.md): start, restart and stop the server from a browser (for phones and tablets, no SSH), with a health-checked restart.
- [Speech sidecar](docs/speech-sidecar.md): the HTTP wire API a speech server implements for dictation and read-aloud.
