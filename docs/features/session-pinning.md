# Session pinning

A running session's instructions, agents, commands, toolsets, skill catalog and custom tools are frozen for its lifetime. Editing config, `AGENTS.md` or a skill's frontmatter never rewrites a live session's cached prompt prefix. New sessions always see what is on disk now, and Stop followed by reopening a session is the refresh.

> **Provider scope.** Pinning works with every model: a session's behaviour does not change mid-conversation. The cache payoff, a byte-stable prefix that keeps Anthropic's cache markers hitting, applies to Claude models; providers with automatic prefix caching gain from the stable prefix too.

## How it works

### What a pin holds

Several pieces of config-derived state shape the request prefix that [prompt caching](prompt-caching.md) depends on. `SessionPin.Snapshot` captures them:

| Field                                 | Shapes                                    |
| ------------------------------------- | ----------------------------------------- |
| `instructions` (global, project)      | System blocks S1 and S2                   |
| `agents`, `agentList`, `defaultAgent` | Agent prompt and agent tool               |
| `skills`                              | The skill tool's description in `tools[]` |
| `commands`                            | Slash commands                            |
| `toolsets`                            | Subagent tool presets                     |
| `custom`                              | Custom tool modules in `tools[]`          |

A session pins a snapshot on first touch: when it is opened (the session `GET` route calls `SessionPin.ensure`) or on its first turn after a server start. Every later turn, compaction and keep-warm ping reads through `SessionPin.get`, so all of them build the same prefix.

### Content-hashed snapshot pool

Freshness is decided by file content, not by events or a reload button. `fingerprint` hashes, with sha256, every file whose content shapes a snapshot:

- the config chain (`opencode.json`, `opencode.jsonc`, `config.json`, `opencode.local.json`, global and up the project tree)
- `command`, `agent`, `mode`, `skill`, `tool` and `plugin` files in every config directory
- external skills under `.claude/skills` and `.agents/skills`, and any `skills.paths` from config
- every instruction file `InstructionPrompt.systemPaths` resolves

The digest is looked up in a pool of snapshots shared by reference count:

| Case                           | Result                                                                                                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Digest already in the pool     | The session joins that snapshot. Sessions on identical disk state share one snapshot and one cache prefix.                                                                              |
| Digest not in the pool         | `reset` drops only the snapshot-input caches (config, instructions, agents, skills, commands, tool registry, MCP clients), `build` re-reads disk, and the new snapshot enters the pool. |
| Last session leaves a snapshot | The entry is removed.                                                                                                                                                                   |

`reset` is deliberately narrower than `Instance.dispose`, which would abort every running turn in the directory. A new session opened after an edit never interrupts a busy sibling.

Custom tool modules are imported with an mtime-versioned specifier (`?v=<mtime>` in `ToolRegistry.state`), because the ESM module cache never invalidates and a bare re-import would return the old module.

### Skill bodies are live

Only a skill's frontmatter (name, description, location) renders into `tools[]`. The body is tool output, read from disk each time the skill is invoked. `skillDigestInput` therefore fingerprints `SKILL.md` files by their frontmatter alone. An edited body reaches a running session on its next skill load without moving the prefix. A frontmatter edit still waits for a new session.

### Releasing and sharing pins

| Event                                                                                | Effect on pins                                                                                               |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Stop, archive or delete (`Session.stop`)                                             | `SessionPin.drop` for the session and its descendants. The next touch re-pins against current disk.          |
| Subagent starts                                                                      | `SessionPin.adopt` gives the child its parent's pin.                                                         |
| Config read with no session (`GET /config`, `GET /provider/default`, `GET /command`) | `SessionPin.refresh` resets stale instance caches without pinning anything and without announcing a dispose. |
| Server restart                                                                       | All pins are cleared. Pins live for the process.                                                             |

## Configuration

No keys. Pinning is always on. To pick up an edit to config, instructions, agents, commands, custom tools or skill frontmatter in an existing session, Stop it and reopen it; a new session sees the edit immediately.

## Why

From commit messages:

- **A running prefix must not move.** "A running session's cached prompt prefix should never change under it." Before pinning, agents, commands, toolsets, instructions and the skill catalog were cached per instance, and a `/global/dispose` mid-session "silently rewrote a running session's system prompt and threw away its whole cache prefix on the next request."
- **Pin time equals disk time.** Picking up a disk edit used to require a manual dispose, through a Reload button, before opening a session. The content-hashed pool made that step unnecessary, and the button was removed.
- **Subagents adopt the parent's pin** so "a reload mid-task can't split them onto different prefixes."
- **Skill bodies are fingerprinted away** because the body "is the part being iterated on, and it was the half that could not be tried without throwing the session away." Measured across a body edit: "cache read held at 62,404 with no write."
- **`refresh` announces nothing.** A config read that announced a cache drop made every client re-bootstrap every open directory, and each bootstrap called the same readers again.

## Code

- `packages/opencode/src/session/pin.ts`: `SessionPin.get`, `ensure`, `refresh`, `adopt`, `drop`, `fingerprint`, `skillDigestInput`, `reset`, `build`
- `packages/opencode/src/session/index.ts`: `Session.stop` (drops pins)
- `packages/opencode/src/session/prompt.ts`: `SessionPin.adopt` calls for subagents
- `packages/opencode/src/server/routes/session.ts`: `SessionPin.ensure` on session attach
- `packages/opencode/src/server/routes/config.ts`, `packages/opencode/src/server/routes/provider.ts`, `packages/opencode/src/server/server.ts` (`command.list`): `SessionPin.refresh`
- `packages/opencode/src/tool/registry.ts`: mtime-versioned import in `ToolRegistry.state`
