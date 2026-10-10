# Skills, instructions and config

Faber extends how skills, instruction files and config are loaded. A skill can opt into a per-turn reminder through its frontmatter, with an optional exit line that is accepted only after the current work has been reviewed, and an optional section re-sent after compaction. Skills can be referenced inline in a prompt with `[USE-SKILL:name]` markers and kept as favorites. A per-machine `AGENTS.local.md` and `opencode.local.json` layer over the committed instruction and config files. A model's config block can describe a model that models.dev does not list, and can name the model's default variant.

## How it works

### Skill discovery

A skill is a folder with a `SKILL.md`. Skills are scanned from, in order (a later skill with the same name replaces an earlier one, with a warning):

| Source                                                                                          | Pattern                      |
| ----------------------------------------------------------------------------------------------- | ---------------------------- |
| `~/.claude/`, `~/.agents/`, then the same folders from the working directory up to the worktree | `skills/**/SKILL.md`         |
| Every config directory (global config dir, `.opencode/` folders)                                | `{skill,skills}/**/SKILL.md` |
| `skills.paths` from config                                                                      | `**/SKILL.md`                |

`OPENCODE_DISABLE_EXTERNAL_SKILLS` turns off the `.claude` and `.agents` scan.

### The skill `reminder` frontmatter

A skill can declare a `reminder` block next to `name` and `description`. This is the public contract (`Skill.Reminder` in `skill/skill.ts`):

| Field     | Required | Meaning                                                                                                                       |
| --------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `sparse`  | yes      | Short text re-sent at the start of every turn while the skill is active                                                       |
| `exit`    | no       | A line prefix the model writes to end the skill's run; without it the skill has no exit gate and stays active for the session |
| `section` | no       | A `## ` heading in the skill body, re-sent once after a compaction; without it nothing is re-sent                             |

```markdown
---
name: refactor-loop
description: Use when the user asks for a multi-step refactor that must end reviewed.
reminder:
  sparse: |
    Work one step at a time. After the last edit, ask a read-only reviewer
    subagent to check the change, then write the exit line.
  exit: "REFACTOR-DONE:"
  section: Checklist
---

# Refactor loop

## Checklist

- Tests pass before and after each step.
- No behaviour change outside the named scope.
```

Lifecycle:

1. **Activation.** When the `skill` tool loads a skill that has a `reminder`, the skill's name is added to `session.activeSkills`, and a fingerprint of the session's edited files at load time is stored.
2. **Every turn.** For each active skill, `insertSkillReminders` appends one block to the turn's opening message, so it never touches already-sent (cached) history (see [turn reminders](turn-reminders.md)). The block starts with a computed ledger and ends with the `sparse` text:

   ```text
   refactor-loop active. since load: 3 turns · 1 commits · current content reviewed: no · write-capable subagents running: 0.
   ```

   Turns and `git commit` calls are counted from the latest load of the skill, or from the last compaction when the load was compacted away.

3. **Exit.** When the newest assistant message's own text has a line starting with `exit`, `skillVerdict` judges it by content, not by order of events. It is accepted only when a [subagent](subagents.md) that could not edit files completed a review at exactly the current file contents, and no write-capable subagent is still running. Accepted: the skill is removed from `activeSkills` and its reminders stop. Refused: the next reminder states why and what to do (wait for the running writers, run a fresh review, or restate the line because a review arrived after it).
4. **Compaction.** On the first turn after a compaction, the `section` named in frontmatter is read from the current skill file on disk and re-sent once, since the full skill body was dropped from history.

Reminders apply only to sessions a person reads: subagents and [headless runs](headless-api.md) get none.

"Current contents" is a fingerprint (`Coverage.fingerprint`) of every file an edit tool touched in the session or in a write-capable child, hashed by content. Editing a file after a review changes the fingerprint, so that review no longer counts. Files under the state directory's `skill-notes/` folder are excluded, so a skill can keep its own notes without invalidating a review.

The `reminder` block is never rendered into the `skill` tool's description, so adding or editing one does not change `tools[]` bytes. It does change the skill fingerprint the session pin compares, so an open session picks it up after Stop and reopen.

### `[USE-SKILL:name]` markers and favorites

The web UI's skill dialog inserts `[USE-SKILL:name] ` at the cursor instead of replacing the prompt, so one prompt can name several skills. The `skill` tool's description tells the model to load every marked skill before answering.

Favorites are stored in `skill.json` under the global state directory, so every client of the server shares one list. `GET /skill/favorite` reads it and `PUT /skill/favorite` replaces it.

### `AGENTS.local.md`

Project instruction files form a first-match-wins chain: `AGENTS.md`, then `CLAUDE.md`, then `CONTEXT.md` (deprecated). `AGENTS.local.md` sits outside that chain:

| Scope        | Where it is read from                                                                     |
| ------------ | ----------------------------------------------------------------------------------------- |
| Global       | The first hit across the config directories                                               |
| Project      | Every directory from the working directory up to the worktree root                        |
| Subdirectory | Beside a directory's chain winner, when a read in that directory injects its instructions |

It loads whether or not an `AGENTS.md` or `CLAUDE.md` exists, never changes which of them wins, and is placed after the committed files so its text comes later and wins on conflict. Nothing writes or gitignores it.

### `opencode.local.json`

| Chain   | Load order (later wins)                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------ |
| Global  | `config.json`, `opencode.json`, `opencode.jsonc`, `opencode.local.json` in the global config directory             |
| Project | `opencode.jsonc`, `opencode.json`, `opencode.local.json`, each found from the working directory up to the worktree |

`.opencode/opencode.json` still loads after the project chain. Config files are strict; keys retired with removed features (`tui`, `keybinds`) are dropped on load rather than rejecting the whole file.

### Model config blocks

`provider.<id>.models.<model>` behaves differently depending on whether models.dev lists the model:

| Model                | Behaviour                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Listed in models.dev | The block overrides only the fields it sets; the rest come from the registry                                                                |
| Not listed           | The block must declare every field the registry would supply, or provider load fails with `PartialModelConfigError` naming the missing ones |

Required fields for an unlisted model: `name`, `family`, `release_date`, `limit.context`, `limit.output`, `cost` (input and output; cache rates default to zero), `reasoning`, `temperature`, `tool_call`, `attachment`, `modalities.input`, `modalities.output`.

Other behaviour of a config entry:

- It is never hidden as deprecated or alpha because of the registry's `status`.
- Prices set in config also replace the registry's long-context prices.
- `variant` names the model's default variant (see [turn parameters](turn-parameters.md)); it must be an enabled variant or load fails with `DefaultVariantError`.
- `variants.<name>.disabled: true` removes a variant.

```json
{
  "provider": {
    "anthropic": {
      "models": {
        "claude-sonnet-4-5": { "variant": "high" }
      }
    }
  }
}
```

## Configuration

| Key                                                     | Effect                                 |
| ------------------------------------------------------- | -------------------------------------- |
| `skills.paths`                                          | Extra folders scanned for `SKILL.md`   |
| `instructions`                                          | Extra instruction files, globs or URLs |
| `provider.<id>.models.<model>`                          | Model override or full definition      |
| `provider.<id>.models.<model>.variant`                  | Default variant for the model          |
| `provider.<id>.models.<model>.variants.<name>.disabled` | Hide a variant                         |

## Why

- **`AGENTS.local.md`.** With a first-match-wins chain, "a repo whose committed instructions live in a CLAUDE.md has nowhere to put rules that belong to a single machine or checkout: dropping an AGENTS.md beside it takes the CLAUDE.md out of the prompt entirely."
- **`opencode.local.json`.** From the comment in `Config.global`: useful "when the config dir is shared or version-controlled: keep machine-specific settings (e.g. MCP servers with per-machine credentials) here." The project chain gained the same file so a per-checkout override has somewhere to live.
- **Complete entries for unlisted models.** models.dev "refreshes hourly on its own, so the values a half-written entry resolved to could change with nothing in the config file changing", and a new model is absent from the registry for days with nothing to inherit.
- **Content-based exit.** The exit used to be judged from the transcript, a count of edits since the last review, which a subagent's edits, a compaction, or a result delivered after the exit line could all fool. Hashing file contents ties a review to exactly what it saw.
- **`[USE-SKILL:name]` markers.** Inserting a reference at the cursor enables "multi-skill prompts without replacing existing input."

## Code

| Area                       | Pointer                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Skill schema and discovery | `packages/opencode/src/skill/skill.ts` (`Skill.Reminder`, `Skill.state`, `Skill.favorites`)                                             |
| Activation                 | `packages/opencode/src/tool/skill.ts` (`SkillTool`, `current`)                                                                          |
| Reminder, exit, section    | `packages/opencode/src/session/prompt.ts` (`insertSkillReminders`, `skillLedger`, `skillVerdict`, `skillExitRequested`, `skillSection`) |
| Review coverage            | `packages/opencode/src/session/coverage.ts` (`Coverage.fingerprint`, `Coverage.state`)                                                  |
| Instruction files          | `packages/opencode/src/session/instruction.ts` (`LOCAL`, `InstructionPrompt.system`, `InstructionPrompt.find`)                          |
| Config chains              | `packages/opencode/src/config/config.ts` (`Config.global`, `RETIRED`, `Skills`)                                                         |
| Model entries              | `packages/opencode/src/provider/provider.ts` (`REQUIRED_MODEL_FIELDS`, `PartialModelConfigError`, `DefaultVariantError`)                |
| Favorites routes           | `packages/opencode/src/server/server.ts` (`/skill/favorite`)                                                                            |
