# Plugin judge

A plugin can ask a model to check one piece of text against one rule, with none of the session's context: no AGENTS.md, no environment block, no project instructions, no tools and no conversation. The plugin supplies the rule and the text and gets the model's reply back as a string. Combined with the `tool.execute.before` hook, this lets a plugin enforce a rule at the tool boundary, for example on a commit message or a file about to be written, instead of relying on the session's model to remember it. Infrastructure failures fail open.

## How it works

Every plugin receives `judge` on its `PluginInput`:

```ts
judge: (input: {
  prompt: string // the rule; becomes the only authored system block
  input: string // the text being judged; sent as the only user message
  sessionID: string
  model: { providerID: string; modelID: string } | "default"
  variant: string // a variant the model offers, or "default"
}) => Promise<string>
```

`SessionJudge.run` builds a hidden synthetic agent named `judge` whose prompt is the caller's rule and whose permissions deny everything, then calls `LLM.stream` directly with:

| Request part      | Value                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------- |
| System            | The caller's `prompt`; environment, global and project instruction blocks passed empty |
| Messages          | One user message containing `input`                                                    |
| Tools             | None                                                                                   |
| Model and variant | As given; `"default"` resolves through `SessionPrompt.defaults`, like any session turn |

The request is otherwise built like a session turn, so effort and thinking come from the chosen variant. A concrete variant the model does not offer is treated as a failure.

Core holds no rules and no verdict format. The plugin decides what to ask, how the model should answer, and what an answer means.

### Deadline and failure

Each call carries its own 30-second deadline, so a hung request cannot strand the tool call it guards.

Any infrastructure failure (model resolution, a provider 500, a network error, the deadline) is caught inside `SessionJudge.run` and returns the empty string. Callers should read `""` as "no verdict" and let the guarded action proceed. A real verdict is always the text of a successful stream, so failing open cannot suppress a genuine refusal.

Usage (input, output, reasoning and cache-read tokens) and the finish reason are logged under the `session.judge` service. A judge call never lands in the session's message list, so the log is the only place its cost shows up.

### Blocking a tool call

`tool.execute.before` runs inside each tool's `execute` wrapper. If the hook throws, the tool call ends in an error and the error message goes back to the model as the tool result, so the model can read why the call was refused and try again.

## Example plugin

A minimal plugin that checks commit message subjects before `git commit -m` runs. Save it as `.opencode/plugins/commit-subject.ts` in a project (or `plugins/` in the global config directory); every exported function is loaded as a plugin.

```ts
import type { Plugin } from "@opencode-ai/plugin"

const RULE = [
  "You check one git commit message against one rule.",
  "Rule: the first line is in the imperative mood (Add, Fix, Remove; not Added, Fixes, Removing)",
  "and is at most 72 characters long.",
  "Reply with exactly one line: PASS, or FAIL: <one-sentence reason>.",
].join("\n")

export const CommitSubject: Plugin = async ({ judge }) => ({
  "tool.execute.before": async (input, output) => {
    if (input.tool !== "bash") return
    const command = String(output.args?.command ?? "")
    const message = /\bgit commit\b[^\n]*?\s-m\s+(["'])([\s\S]*?)\1/.exec(command)?.[2]
    if (!message) return

    const verdict = (
      await judge({
        prompt: RULE,
        input: message,
        sessionID: input.sessionID,
        model: "default",
        variant: "default",
      })
    ).trim()

    // "" means the judge itself failed: allow the command.
    if (verdict.startsWith("FAIL")) {
      throw new Error(`Commit blocked by the commit-subject rule. ${verdict}`)
    }
  },
})
```

Points that carry over to other rules:

- Extract only the artifact the rule is about (here the message, not the whole shell command) so the model weighs the rule against that and nothing else.
- Fix the verdict format in the rule and parse it strictly. Anything that is not an explicit failure, including an empty reply, allows the action.
- Put the reason in the thrown error. The model sees it as the tool result and can correct the message.

## Configuration

No config keys. Plugins load from `plugin/` or `plugins/` folders in the project's `.opencode/` directory and the global config directory, and from the `plugin` config key (npm packages or `file://` URLs).

## Why

- **One rule, one artifact.** From the commit that added it: "A skill states its rules as absolutes, then the session accumulates forty more skills and a 200KB prefix, and the rule that mattered competes with everything else for attention. Re-checking one rule at the tool boundary needs the opposite shape: one instruction, one artifact, nothing else."
- **Clean prefix.** A plugin could already reach a model through the SDK, but only through a session prompt, which always loads AGENTS.md. A fresh session with no tools measured 47,225 tokens of prefix before the input; the judge call measured 37.
- **Fail open in core.** "The judge is an enforcement gate, not the user's turn: a 500 or timeout must fail open, never throw." The guarantee originally lived in one plugin's `.catch`; it moved into core so every caller gets it.
- **No forced thinking settings.** An earlier version forced thinking off and capped output; one model rejected the disabled-thinking parameter with a 400, so every judged write passed unjudged. The judge now runs as a plain turn on the chosen model and variant.

## Code

| Area             | Pointer                                                                              |
| ---------------- | ------------------------------------------------------------------------------------ |
| Judge call       | `packages/opencode/src/session/judge.ts` (`SessionJudge.run`, `DEFAULT_TIMEOUT`)     |
| Plugin API       | `packages/plugin/src/index.ts` (`PluginInput.judge`, `Hooks["tool.execute.before"]`) |
| Wiring           | `packages/opencode/src/plugin/index.ts` (`Plugin.trigger`, plugin `state`)           |
| Hook call sites  | `packages/opencode/src/session/prompt.ts` (`resolveTools`)                           |
| Plugin discovery | `packages/opencode/src/config/config.ts` (`PLUGIN_GLOB`, `loadPlugin`)               |
