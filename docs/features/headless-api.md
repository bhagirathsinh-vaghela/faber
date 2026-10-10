# Headless agent and one-shot APIs

Two HTTP routes let another program use Faber as a backend without driving a session. `POST /agent/headless` runs a named agent to completion with nobody attached and returns its final message, token usage, cost, turn count and every permission it was refused; the session it used is removed afterwards. `POST /oneshot` makes a single model call with a system prompt and a prompt, with no session, no tools and no instructions, and returns the text. A third route, `GET /provider/default`, tells a caller which agent, model and variant `"default"` resolves to.

## How it works

### `POST /agent/headless`

Request (`HeadlessAgent.Input`):

| Field       | Meaning                                                                         |
| ----------- | ------------------------------------------------------------------------------- |
| `agent`     | Agent name, for example `build` or `plan`                                       |
| `prompt`    | The task                                                                        |
| `system`    | Optional extra instructions, sent ahead of the prompt as a text part            |
| `model`     | `provider/model`, or `"default"` for the agent's model, then the configured one |
| `variant`   | A variant the model offers, or `"default"`                                      |
| `bare`      | Leave out AGENTS.md, MCP tools and skills; defaults to `true`                   |
| `timeoutMs` | Deadline for the whole run; defaults to 10 minutes                              |
| `keep`      | Keep the session afterwards for debugging; its id comes back as `session_id`    |

Response (`HeadlessAgent.Result`): `result` (the last assistant message's own text), `finish`, `num_turns`, `usage` (`input`, `output`, `reasoning`, `cacheRead`, `cacheWrite`, summed over every step), `cost`, `permission_denials`, `model`, `is_error`, `errors`. Failures come back as `is_error: true` with a reason, not as an HTTP error.

The run:

1. Creates a session with `ephemeral: true`. `Session.attended` reports an ephemeral session as unattended, so it is kept out of the session list and the web UI and skips keep-warm pings, titles and reminders.
2. Applies a ruleset that denies `question`, `plan_enter`, `plan_exit` and `agent`: nobody can answer a question or approve a mode switch, and the run does not spawn subagents.
3. Denies every other permission prompt on the spot and records it (`PermissionNext.headless`). The model sees the denial and carries on; the caller gets the list.
4. Sends the prompt through `SessionPrompt.send`, the same loop a subagent runs.
5. Waits until the session is done by the same rule `Recovery.done` applies to a subagent's result, including background jobs the agent started. It re-checks on every `session.busy` push for the session, with a 5-second polling net for a missed push.
6. Stops and removes the session unless `keep` is set.

The run ends early, the same way as on its deadline, when the HTTP caller disconnects: the route passes the request's abort signal, the session is stopped, its jobs are killed, and the session is removed. At server startup, `HeadlessAgent.sweep` stops and removes any headless session created before the server started, since its caller's connection died with the old server.

The route disables the server's idle timeout for the request, since nothing is written to the connection until the run finishes.

### `POST /oneshot`

Request (`Oneshot.Input`):

| Field       | Meaning                                                                                 |
| ----------- | --------------------------------------------------------------------------------------- |
| `system`    | Optional system prompt                                                                  |
| `prompt`    | The user message                                                                        |
| `model`     | `provider/model`, or `"default"`                                                        |
| `variant`   | A variant the model offers, or `"default"`                                              |
| `cache`     | Put one 1-hour cache marker on the system prompt and none on the prompt; off by default |
| `timeoutMs` | Defaults to 2 minutes                                                                   |

Response (`Oneshot.Result`): `result`, `finish`, `usage`, `cost`, `model`, `is_error`, `errors`.

The call goes straight to `LLM.stream` with a synthetic hidden agent whose permissions deny everything, an empty tool set, and empty environment and instruction blocks. Nothing is persisted. A concrete variant the model does not offer is rejected before any request is made.

`Oneshot.stream` is the in-process streaming form. It yields `text` events with the answer's text deltas (reasoning parts are dropped), then exactly one `done` event with model, usage, cost and a count of reasoning blocks, or one `error`. Any finish reason other than `stop` is an error, so a truncated answer is never delivered as complete. The read-aloud rewrite in [voice](voice.md) uses this path with `cache: true`.

### `GET /provider/default`

Returns `{ providerID, modelID, variant, agent }` for what a new session in the directory runs when the caller names nothing, or `null` when no provider is connected. It uses `SessionPrompt.defaults`, the same resolver the headless and one-shot routes use for `"default"`.

### Example

With the server started as `opencode serve --port 4096` (it binds 127.0.0.1 by default):

```bash
curl -s http://127.0.0.1:4096/agent/headless \
  -H 'content-type: application/json' \
  -d '{"agent":"plan","prompt":"Summarize what src/server does.","model":"default","variant":"default"}'

curl -s http://127.0.0.1:4096/oneshot \
  -H 'content-type: application/json' \
  -d '{"system":"Answer in one word.","prompt":"Capital of France?","model":"default","variant":"default"}'
```

Like other instance routes, both accept a `?directory=` query parameter naming the project to run in.

## Configuration

No dedicated config keys. `"default"` resolves through the `model` key, the agent's `model` and `variant`, and a model block's `variant` (see [turn parameters](turn-parameters.md)).

## Why

- **Headless agent.** "An app that needs an agent to do real work (read files, run commands) had to drive a session and clean it up."
- **One-shot.** "Apps that only need an answer from the model had to create a session, prompt it, and leave it behind."
- **Cache off by default.** "A single call never reads back what it wrote", so a cache write would be paid for nothing. Only a caller that reuses its system prompt across calls should turn it on.
- **Explicit model and variant.** "A call runs on what its caller chose instead of whatever the config resolves."
- **Waiting for jobs.** A turn can end while a background job it started is still running; the job's result wakes the session for another turn, so returning at the first turn end would drop work and deliver the result into a removed session.
- **Push-driven waiting.** The run used to poll every second for up to ten minutes; waiting on `session.busy` pushes returns as the last turn ends.
- **Stopping on disconnect.** A run whose caller hung up used to continue to its deadline "for an answer nobody would receive."

## Code

| Area           | Pointer                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------- |
| Headless run   | `packages/opencode/src/session/headless.ts` (`HeadlessAgent.run`, `HeadlessAgent.sweep`, `RULES`) |
| One-shot       | `packages/opencode/src/session/oneshot.ts` (`Oneshot.run`, `Oneshot.stream`, `Oneshot.target`)    |
| Routes         | `packages/opencode/src/server/routes/headless.ts`, `oneshot.ts`, `provider.ts` (`GET /default`)   |
| Denial capture | `packages/opencode/src/permission/next.ts` (`PermissionNext.headless`)                            |
| Done rule      | `packages/opencode/src/session/recovery.ts` (`Recovery.done`)                                     |
| Attended check | `packages/opencode/src/session/index.ts` (`Session.attended`)                                     |
