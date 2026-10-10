# Turn reminders

Faber restates selected rules and state changes where the model reads them next, without breaking the prompt cache. Every injected reminder (concise style, question tool, plan and build mode, skill checklists, date or branch changes, MCP and subagent catalogs, the subagent "cannot delegate" note) goes through one funnel that appends it to the message that opens the current turn. A write that would land on a message already sent to the API is refused.

> **Provider scope.** Reminders work with every model. Appending them to the turn's opening message instead of editing earlier text is what keeps Anthropic's cache valid; providers with automatic prefix caching benefit from the same discipline without markers.

## How it works

### The turn opener

`MessageV2.turnOpener` returns the newest user message: whatever opened the current turn, whether a typed prompt, a question answer, or a background result delivered to an idle session. Until the model answers it, the opener has not been sent. Anything appended to it sits after every block already on the wire, so the cached prefix behind it stays byte-identical (see [prompt caching](prompt-caching.md)).

`appendSyntheticPart` is the only writer. It resolves the opener itself, so no caller can name a different target. It persists the reminder as a text part on the opener, flagged `synthetic` and `internal`, and mirrors it into the in-memory messages the turn is about to send. If an assistant message already follows the opener, the write is refused and logged as `refused prompt injection onto an already-sent message`.

`persistReminder` wraps text in `<system-reminder>` tags with an HTML-comment marker such as `<!-- concise-reminder -->`. The markers let each injector check whether its reminder is already present, so a reminder lands once per opener.

### What gets injected

`SessionPrompt.insertReminders` runs before each request and calls the injectors in order:

| Injection                                       | When                                                                                                                                                        | Scope                |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| MCP catalog (`insertMcpCatalog`)                | The catalog built for the session's instance differs from the one last injected. A fresh full block is appended; older blocks stay as inert history.        | Not in bare sessions |
| Project subagent catalog (`insertAgentCatalog`) | Once per session, when the repository defines its own subagents. Keeps them out of the agent tool's description in `tools[]`.                               | Root sessions        |
| Session context update (`insertSessionContext`) | The local date or the git branch differs from what the model was last told. Appends `<session_context_update>`; the frozen system block is never rewritten. | All                  |
| Concise reminder                                | Each new turn opener, when `concise` is set for the model.                                                                                                  | Root sessions        |
| Question-tool reminder                          | Each new turn opener, when the question tool is registered.                                                                                                 | Root sessions        |
| Skill reminders (`insertSkillReminders`)        | Each new turn opener while a skill with `reminder` frontmatter is active.                                                                                   | Root sessions        |
| Subagent "cannot delegate"                      | Once per subagent session.                                                                                                                                  | Subagents            |
| Plan and build reminders                        | Entering plan mode, every 5 assistant turns in plan mode, and switching back to build. A subagent whose parent is in plan mode also gets the plan reminder. | All                  |

"Root sessions" means sessions a person reads (`Session.attended`): not subagents and not headless runs. A subagent's output is read by its parent model, so the concise reminder is skipped there, as stated in the code comment on `insertReminders`.

### Plan mode cadence

On entering plan mode, the full plan reminder is injected. While plan mode continues, a reminder is re-injected after every `TURNS_BETWEEN_REMINDERS` (5) assistant turns. Every `FULL_REMINDER_EVERY_N` (5) reminders, the full text is used; the rest use a shorter sparse text. Leaving plan mode injects a build-switch reminder that points at the plan file. `planScan` derives the counts by walking history backward to the most recent plan exit.

### Skill reminders

A skill opts in through its frontmatter:

```yaml
---
name: release-check
description: Walk a release through its checklist before tagging it.
reminder:
  sparse: Run the full test suite before tagging.
  exit: "RELEASE-DONE:"
  section: Checklist
---
```

| Field              | Effect                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reminder.sparse`  | Required. Text re-injected on every turn opener while the skill is active.                                                                            |
| `reminder.exit`    | Optional. A line prefix the model writes to end the run. Without it, the skill has no exit gate.                                                      |
| `reminder.section` | Optional. The `## ` heading of the skill body re-injected once on the first turn after a compaction, when the loaded body has dropped out of history. |

Loading a skill through the skill tool adds it to the session's `activeSkills`. The list survives compaction. On every turn opener, each active skill gets a reminder that starts with a computed ledger (`skillLedger`): turns and commits since the skill was loaded (or since the last compaction), whether the current content has been reviewed, and how many write-capable subagents are still running. The skill's `sparse` text follows.

When the model writes a line starting with the declared `exit` prefix, `skillVerdict` judges it by content, not by transcript order. `Coverage.fingerprint` hashes every file an edit tool touched in the session or in a write-capable child session. The exit is accepted only if a completed read-only subagent review recorded that same fingerprint, the review arrived no later than the exit line, and no write-capable subagent is still running. On acceptance the skill leaves `activeSkills`. Otherwise the next reminder states that the exit was refused, why, and what to do next.

### Todo verification nudge

One more nudge works differently: it is appended to the todo tool's own output, which is new content by definition. When a single `todowrite` call newly marks three or more tasks completed and no task mentions verifying or testing, the result ends with a note to run the relevant tests or build before moving on.

## Configuration

| Key                                                        | Effect                                                                                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `concise`                                                  | Map of `provider/model` to `true` to opt a model into the concise reminder, for example `{ "anthropic/claude-opus-5": true }`. Absent or `false` means no reminder. |
| Skill frontmatter `reminder` (`sparse`, `exit`, `section`) | Opts a skill into per-turn reminders, as above.                                                                                                                     |

The concise reminder text is: "Keep replies concise: lead with the answer, no preamble, no recap. This governs user-facing text only, not how much you read, investigate, or think before acting."

## Why

From commit messages and code comments:

- **Restating rules per turn.** "Concision rules in the system prompt or instructions are written once and then sit thousands of tokens behind everything the turn adds, so a long turn drifts back to narrating its work." The per-turn reminder is inspired by Claude Code's Concise output style. The question-tool reminder follows the same reasoning: the model "drifts to typing questions late in" a long conversation.
- **Only the turn opener.** An earlier version re-stated the concise reminder every 5 assistant steps by appending to the turn's first user message, which had already been sent on every prior step. On the wire, cache reads stayed at 83,568 tokens while cache writes climbed from 19k to 63k across four consecutive calls. Restricting every injection to the unsent opener fixed it, and the refusal guard catches a future change that would reintroduce the problem "loudly, instead of billing a silent miss."
- **Persisted plan reminders.** Plan and build reminders were once spliced into the request and vanished on the next turn, "breaking both cache prefix stability and model adherence to plan mode constraints after a few turns."
- **"Cannot delegate" in conversation, not by removing the tool.** A subagent carrying a different tool list from its parent "loses the cache parity that makes delegation cheap."
- **Skill exits judged by content.** A transcript count could be fooled by a subagent's edits, a compaction, or a result delivered after the exit line. `activeSkills` survives compaction on purpose, because compaction drops the message that loaded the skill "exactly when the reminder matters most."

## Code

- `packages/opencode/src/session/prompt.ts`: `insertReminders`, `appendSyntheticPart`, `persistReminder`, `reminderDue`, `insertMcpCatalog`, `insertAgentCatalog`, `insertSessionContext`, `insertSkillReminders`, `skillLedger`, `skillVerdict`, `skillSection`, `planScan`, `CONCISE`, `TURNS_BETWEEN_REMINDERS`, `FULL_REMINDER_EVERY_N`
- `packages/opencode/src/session/message-v2.ts`: `MessageV2.turnOpener`, `MessageV2.isTurnOpener`
- `packages/opencode/src/session/system.ts`: `SystemPrompt.sessionContextUpdate`
- `packages/opencode/src/skill/skill.ts`: `Skill.Reminder`
- `packages/opencode/src/tool/skill.ts`: `activeSkills` stamped on load
- `packages/opencode/src/session/coverage.ts`: `Coverage.fingerprint`, `Coverage.state`
- `packages/opencode/src/tool/todo.ts`: `TodoWriteTool` verification note
