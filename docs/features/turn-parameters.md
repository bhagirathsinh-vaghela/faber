# Turn parameters

Every turn runs under one agent, one model and one variant, chosen when the turn starts and stored on the session. Messages that arrive during the turn (a background job result, a subagent result, a compaction continue, a prompt typed mid-turn) join it under those same parameters, so nothing injected by the server can silently move a session to a different model, variant or mode. In the web UI, a model, variant or agent pick is a pending choice held by that browser tab and applied only when that tab sends.

## How it works

### `session.current`

The session record carries `current: { agent, model, variant }`, the parameters the session runs as. It is the persistent source of truth read to stamp every user message, real or synthetic.

| Writer                                                                            | Effect on `current`                          |
| --------------------------------------------------------------------------------- | -------------------------------------------- |
| A prompt a person sent                                                            | Resolves the parameters and writes them back |
| A synthetic message (job or subagent result, compaction continue, restart resume) | Reads `current`, never writes it             |
| An approved plan switch                                                           | Sets `current.agent` (`Session.setAgent`)    |
| A spawned session                                                                 | Seeded from its spawner at create time       |

`createUserMessage` resolves each field in the same order:

```text
agent:   request ?? current.agent ?? default agent
model:   request ?? current.model ?? agent's model ?? configured default
variant: request ?? current.variant (only while the model is unchanged) ?? agent's variant (if the model offers it) ?? the model's configured variant
```

Inside the server, a launch always states its model and variant as a concrete value, `"inherit"` (`Provider.INHERIT`, the session's current) or `"default"` (`Provider.DEFAULT`, the agent's, then the config's). `SessionPrompt.defaults` is the one place that resolves `"default"`. A concrete variant the model does not offer is an error rather than a silent fallback.

### One parameter set per turn

`SessionPrompt.run` claims the turn's parameters synchronously, before its first `await`, in a per-session slot (`turnParams`). The slot is a promise: a second prompt that arrives while the first is still resolving waits on it instead of racing to resolve its own.

| Message                                                 | Parameters it runs under                                     |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| Opens a turn (session idle)                             | Resolved fresh, then published to the slot                   |
| Joins a running turn                                    | The slot's parameters, not the picks the client sent         |
| Carries explicit `params` (a plan switch, a compaction) | Its own; it also replaces the slot for the rest of that turn |

Every path that starts a turn goes through a claim. `SessionPrompt.wake` starts a turn on messages already written (a restart recovery, `/summarize`, a retry) and claims the newest user message's parameters first. The internal `loop` is not exported, and a test pins that nothing outside `session/prompt.ts` can start a turn without a claim.

Changing parameters mid-turn is deliberately not possible from a prompt: interrupt, change the pick, then send.

### Per-model default variant

A model block in config may name a `variant`. It applies when neither the request nor the agent names one. An agent-level `variant` applies only to models that offer it. A default that names a variant the model does not offer fails provider load with `DefaultVariantError`, which lists the variants the model does offer.

### Pending picks in the web UI

The model, variant and agent chips in the prompt dock are per-tab, per-session pending picks (`packages/app/src/context/local.tsx`):

- An open session's baseline is what it runs: its `current`, synced to every client.
- A pick that differs from the baseline shows a pending dot and rides on the next prompt from that tab.
- A pick equal to the baseline is dropped, so the chip follows the session when a plan switch or another client moves it.
- An open session only sends an agent when the pick differs from what it runs, so a tab showing a stale agent cannot switch the session back.
- Nothing is persisted server-side; a reload drops pending picks.

`GET /provider/default` returns the default agent, model and variant a new session would run, resolved by the same `SessionPrompt.defaults` the server uses, so a client never computes its own.

## Configuration

| Key                                                     | Effect                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| `model`                                                 | Default `provider/model` when no agent names one                    |
| `agent.<name>.model`                                    | Model for that agent                                                |
| `agent.<name>.variant`                                  | Default variant for that agent, used only on models that offer it   |
| `provider.<id>.models.<model>.variant`                  | Default variant for that model; must be one of its enabled variants |
| `provider.<id>.models.<model>.variants.<name>.disabled` | Removes a variant from a model                                      |

## Why

- **Synthetic turns reset the variant.** Plan switches, result injections, compaction and shell turns named no variant, and the resolver read only the newest message, so "a turn that named nothing was read as a turn that chose the default."
- **One overloaded flag.** The `synthetic` flag answered "one overloaded question that ten consumers read for different reasons": whether a person typed the message, and which parameters the session runs as. `session.current` separates the second question from the first; `MessageV2.isHumanTyped` answers the first.
- **Joined results flipped the mode back.** A job result that joined after an approved `plan_exit` adopted the turn's old agent, so the session re-entered plan mode right after approval.
- **Turns started without a claim.** Recovery, `/summarize` and a retry path started the loop directly, so a prompt sent into those turns could switch the mode or model mid-turn. `wake` closed that gap.
- **Agent variants on models without them.** The agent was the only place to set a default variant, so "one value applied to every model the agent ran, including models that do not offer it." The per-model `variant` key fixes that.

## Code

| Area              | Pointer                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Session field     | `packages/opencode/src/session/index.ts` (`Session.Info.current`, `Session.setAgent`)                                  |
| Resolution        | `packages/opencode/src/session/prompt.ts` (`createUserMessage`, `SessionPrompt.defaults`, `inherited`, `resolveAgent`) |
| Turn claim        | `packages/opencode/src/session/prompt.ts` (`run`, `turnParams`, `SessionPrompt.wake`, `SessionPrompt.deliver`)         |
| Sentinels         | `packages/opencode/src/provider/provider.ts` (`Provider.INHERIT`, `Provider.DEFAULT`, `DefaultVariantError`)           |
| Default route     | `packages/opencode/src/server/routes/provider.ts` (`GET /default`)                                                     |
| Web pending picks | `packages/app/src/context/local.tsx`                                                                                   |
