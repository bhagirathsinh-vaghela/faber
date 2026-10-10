# Question tool

When the model needs a decision, it calls the `question` tool and the user answers in a picker in the web UI: click an option, pick several, or type a free-text answer. Once the question is settled, Faber rewrites it in the transcript the model sees. On Anthropic models, the tool call is removed from the model's own turn, and the full question plus the answer is stored as the user's own message. This keeps the model calling the tool for its next question instead of typing look-alike questions as plain text.

## How it works

### Asking

The tool takes a list of questions, each with a `header`, the `question` text, `options` (label plus optional description) and a `multiple` flag. `Question.ask` blocks the turn until the user answers or dismisses it. The tool is registered for the app, CLI and desktop clients. It is in no subagent preset: a subagent has no human to answer.

### The panel

The question panel sits above the prompt dock. It handles several pending questions as tabs, a single-question fast path, multi-select, custom typed answers and a review step. Escape collapses it to a one-line bar without answering; the question stays pending and the bar keeps an accent so it still draws attention. Whether a new question opens expanded or collapsed follows the box-defaults setting. Answering on any client clears the question on every client.

### What the model sees afterwards

On Anthropic, when the question is answered, dismissed or ended, `SessionPrompt.transcribe` writes two things in one transaction:

1. The tool part in the model's turn is replaced, under its own id, by an empty text record.
2. The question and answer are written as the user's message, built by `MessageV2.record`:

```text
[Your question tool call: you called the question tool and the user answered in the picker. Only the question tool shows the user a picker, so keep using it for your next question.]
Header: Deploy target
You asked: Which environment should this go to?
Options (pick one):
- Staging (Recommended) — safe default
- Production — live traffic
I chose: Staging (Recommended)
```

An unanswered question gets the same shape with the reason (for example, the turn was cut off) and no choice. The record carries every field of the original call, since the call itself is gone from the model's turn. Both records keep the question so the UI still draws its card.

Other providers keep the ordinary tool call and tool result.

### Keeping the model on the tool

| Mechanism                                                                                | Where                                                         |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| A system-prompt fragment explaining when to use the tool and what past records look like | `session/prompt/question.txt`, added when the tool is present |
| A short reminder appended to every new turn opener in sessions a person reads            | `SessionPrompt` question reminder                             |

The fragment tells the model that any question with a fixed set of answers goes through the tool, and that writing options into reply text shows the user no picker.

### Restarts and stops

A question the model was waiting on when the server died is closed as unanswered before the turn resumes (see [restart recovery](restart-recovery.md)). A question ended by Stop or Esc is recorded so nothing resumes or wakes on it.

### Plan mode confirmations

Entering and leaving plan mode asks Yes/No through the same picker. A typed answer other than Yes or No is passed back to the model as the user's reply to act on before asking again.

## Configuration

No config keys. The tool goes through the permission system as `question`.

## Why

- **The answer reads as the user's words.** After a tool result, Anthropic models can return the prose written before their next tool call as a summarized thinking block, which the user never sees. After a user message they do not. The rewrite is therefore Anthropic-only; another provider may bill a request ending in a user message as user-initiated (`MessageV2.stampable` comment).
- **Nothing question-shaped stays in the model's turn.** The model copies the shape of its past turns. With a text record of the question in its own turn, it typed questions in that shape instead of calling the tool; rewording the record as a past-tense fact did not help, and moving it to the user's side did (`MessageV2.record` comment).
- **Every field is kept.** An earlier record dropped option descriptions, and the model then no longer knew what it had offered.
- **Collapse, not defer.** An earlier design let Escape defer a question so the turn would not block while the prompt cache went cold. With keep-warm pings holding the cache, blocking costs nothing, and the panel collapses instead (`QuestionPanel` comment).
- **Typed answers for plan confirmations.** Yes/No alone lost replies such as "not yet, add a rollback step".

## Code

- `packages/opencode/src/tool/question.ts`: `QuestionTool`
- `packages/opencode/src/session/prompt.ts`: `SessionPrompt.transcribe`, question reminder
- `packages/opencode/src/session/message-v2.ts`: `MessageV2.record`, `MessageV2.stampable`, `MessageV2.spoken`
- `packages/opencode/src/session/prompt/question.txt`
- `packages/opencode/src/tool/plan.ts`: `confirm`
- `packages/app/src/components/question-panel.tsx`: `QuestionPanel`
