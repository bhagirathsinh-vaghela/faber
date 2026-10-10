# Plan mode

Plan mode is the `plan` agent: the model researches and writes a plan file, and may not change anything else. In Faber, switching between `plan` and `build` does not change the request's tool list, so the switch costs no prompt-cache miss. Every tool stays on the wire in both modes; plan mode restricts edits to the plan file and limits MCP tools to the read-only ones when a call executes. The model can also propose entering or leaving plan mode itself through the `plan_enter` and `plan_exit` tools, and a typed reply to that proposal is passed back to the model instead of being discarded.

## How it works

### Same tools, gated at execute time

Anthropic hashes `tools[]` first, ahead of the system prompt and the conversation (see [prompt caching](prompt-caching.md)). Removing the edit tools in plan mode would change those bytes and invalidate the whole cached prefix on every plan/build switch. Instead, `SessionPrompt.allowlist` derives an allowlist for the `plan` agent with `planAllowlist`:

| Tool class                                                        | Plan mode behaviour                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `edit`, `write`, `multiedit`, `apply_patch` (`PATH_SCOPED_TOOLS`) | Allowed only when every target path matches a plan-file glob             |
| MCP tools                                                         | Allowed only when the server marks the tool read-only (`Agent.MCP_READ`) |
| Every other registered tool                                       | Allowed                                                                  |

The allowlist never removes a tool from the request schema. `SessionPrompt.toolDenial` runs inside each tool's `execute` wrapper and returns a denial message the model can read, for example `Tool "edit" is restricted to .opencode/plans/*.md, ... for this task.`

Path checks resolve each target the way the tools do (`Filesystem.resolve`, which also expands `~`), then normalize it, so a `../` segment cannot step out of an allowed folder. For `apply_patch`, `scopedTargets` parses the patch and checks every file it names, counting a moved file at both its old and new path. A call that names no path the gate can read is denied.

### Read-only MCP tools

An MCP tool counts as read-only only when its connected server advertises `annotations.readOnlyHint === true` for it (`MCP.readOnly`). The MCP spec makes that hint optional and defaulting to false, so an absent or false hint is treated as a write and the tool is denied in plan mode. A misclassified tool can therefore be wrongly denied, never wrongly allowed.

### The plan file

`Session.plan` names the file `<created>-<slug>.md`:

| Project        | Location                                   |
| -------------- | ------------------------------------------ |
| Git repository | `.opencode/plans/` under the worktree      |
| No VCS         | `plans/` under the OpenCode data directory |

The allowlist accepts `*.md` under either location, so a plan written before a repository was initialized is still editable.

### Model-driven switching

`plan_enter` and `plan_exit` are registered for every client (`ToolRegistry`), so they sit in `tools[]` for every agent and the tool list is identical in both modes. Agent permissions decide who may call which: `build` allows `plan_enter`, `plan` allows `plan_exit`, and every other agent is refused at execute time.

Both tools share `confirm` in `tool/plan.ts`, which asks the user through the [question tool](question-tool.md):

| Answer         | Result                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| Yes            | Delivers a synthetic message naming the target agent, then sets `session.current.agent`                 |
| No             | Throws `Question.RejectedError`; nothing switches                                                       |
| Any typed text | Nothing switches; the tool result carries the text and tells the model to act on it before asking again |
| Empty          | Nothing switches                                                                                        |

The switch message is delivered with `params: { agent }`, which takes precedence over the running turn's parameters. A job or subagent result that joins the turn afterwards adopts the new agent instead of flipping the session back (see [turn parameters](turn-parameters.md)).

### Reminders

Plan-mode instructions are re-stated in the conversation, not in the system prompt, and persisted onto the turn's opening message so they stay in the cached history (see [turn reminders](turn-reminders.md)). `SessionPrompt.insertReminders` picks the text:

| Situation                          | Reminder                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Entering plan mode                 | Full plan instructions (`prompt/plan.txt`), plus `plan-reentry.txt` when a plan file from an earlier exit exists                                             |
| Staying in plan mode               | Every 5 assistant messages; full text on the 1st, 6th, 11th and so on reminder (every fifth, counting from the first), the short `plan-sparse.txt` otherwise |
| Leaving for build                  | `build-switch.txt`, with the plan file path when it exists                                                                                                   |
| Subagent of a session in plan mode | `plan-subagent.txt`, pointing at the parent's plan file                                                                                                      |

## Configuration

Plan mode has no dedicated config keys. The `plan` agent's permissions can be overridden like any agent's through the `agent` and `permission` config keys, which merge over the built-in defaults in `Agent`.

## Why

- **Cache-stable switching.** Plan mode used to deny edits through an agent permission, which removed the edit tools from `tools[]`; per the commit that replaced it, "every plan<->build switch took a full cache miss on the largest part of the request." The allowlist keeps `tools[]` byte-identical across the switch.
- **Tools on by default.** `plan_enter` and `plan_exit` were behind an experimental flag and a CLI-only client check, so the model-driven switch never fired in a normal session. Registering them adds about 390 tokens to the cached prefix, paid once at write price per session and read-priced afterwards.
- **Typed replies.** The switch picker used to offer only Yes and No, so a reply like "not yet, add a rollback step" had nowhere to go.
- **Keeping the agent through a switch.** A result that joined a turn after an approved `plan_exit` adopted the turn's old agent, so the loop re-entered plan mode right after approval. Approved switches now replace the turn's parameters.

## Code

| Area                            | Pointer                                                                                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Allowlist and execute-time gate | `packages/opencode/src/session/prompt.ts` (`planAllowlist`, `allowlist`, `toolDenial`, `scopedTargets`, `PATH_SCOPED_TOOLS`)                    |
| MCP read-only classification    | `packages/opencode/src/mcp/index.ts` (`MCP.readOnly`); `packages/opencode/src/agent/agent.ts` (`Agent.MCP_READ`, `Agent.MCP_WRITE`)             |
| Switch tools                    | `packages/opencode/src/tool/plan.ts` (`PlanEnterTool`, `PlanExitTool`, `confirm`)                                                               |
| Plan file path                  | `packages/opencode/src/session/index.ts` (`Session.plan`)                                                                                       |
| Reminders                       | `packages/opencode/src/session/prompt.ts` (`insertReminders`, `planScan`); `packages/opencode/src/session/prompt/plan*.txt`, `build-switch.txt` |
| Agent permissions               | `packages/opencode/src/agent/agent.ts` (`plan` and `build` entries)                                                                             |
