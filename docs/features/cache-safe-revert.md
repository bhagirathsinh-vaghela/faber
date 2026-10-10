# Cache-safe revert

"Revert here" rolls a session back to an earlier user message and re-seeds the prompt cache entry for the conversation up to that point first. The next prompt after the revert continues on a cache hit, even when the entry for that point had expired or sat beyond Anthropic's 20-block lookback.

## How it works

### The problem

A revert hides every message from the chosen point onward, and the next prompt is sent against the shorter history. Whether that request hits the cache depends on whether a live entry exists ending somewhere inside the 20 blocks before the new tail. In a long session, the cache entries from earlier turns have usually expired, and the rolling marker from the latest turn sits far past the revert point. Without help, the first request after a revert rewrites the whole conversation.

### The cache probe

A one-shot cache probe moves a request's rolling marker (marker 4, see [prompt caching](prompt-caching.md)) from the newest message onto a chosen earlier message. `selectCacheMarkers` places the marker on the probe target instead of the tail. Sending a request with the probe writes, or refreshes, the cache entry for the conversation up to that message.

The probe rides a keep-warm ping, which persists nothing: `SessionPing.probe` stops the daemon, sends one ping with `cacheProbeMessageID`, and restarts the daemon. `LLM.stream` resolves the message id to its block index by adding the number of system blocks to the message's conversation index. This works whether or not `ping.enabled` is set.

### The revert flow

The web UI's "Revert here" button on a user message card opens a confirm dialog (Enter confirms, Escape cancels), then runs three calls in order:

| Step | Call                                                                                                           | Purpose                                                           |
| ---- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1    | `POST /session/:sessionID/unrevert`                                                                            | Clears any earlier revert bookmark.                               |
| 2    | `POST /session/:sessionID/ping` with `cacheProbeMessageID` set to the last assistant message before the target | Seeds the cache entry ending where the reverted history will end. |
| 3    | `POST /session/:sessionID/revert` with the target `messageID`                                                  | Sets the revert bookmark. Later messages are hidden.              |

The target message's text is then restored to the composer, so it can be edited and resent.

A revert is a bookmark until the next prompt. `SessionRevert.cleanup` deletes the hidden messages when the next prompt starts, and `unrevert` restores them before then.

The probe can also be set for the next real turn: `PATCH /session/:sessionID` accepts `cacheProbeMessageID` (or `cacheProbeIndex`), and the turn loop reads and clears it before its next request.

### File changes

By default a revert also restores files the reverted turns changed, using git snapshots of the worktree. With `undo.revertFiles` set to `false`, `SessionRevert.revert` only sets the bookmark and skips snapshot tracking, file restore and diff computation entirely.

## Configuration

| Key                | Default | Effect                                                                                                       |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------------ |
| `undo.revertFiles` | `true`  | When `false`, revert and unrevert change messages only. No files are restored and no git snapshot work runs. |

HTTP:

| Route                                                                  | Body                                                                              |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `POST /session/:sessionID/ping`                                        | `{ "cacheProbeMessageID": "<message id>" }`                                       |
| `PATCH /session/:sessionID`                                            | `{ "cacheProbeMessageID": "<message id>" }` for a one-shot probe on the next turn |
| `POST /session/:sessionID/revert`, `POST /session/:sessionID/unrevert` | Standard revert routes                                                            |

## Why

The probe's stated purpose, from the commit that introduced it: it "re-seeds or refreshes the cache entry for the conversation up to it, even when the entry expired or lies beyond the 20-block lookback, so a fork or revert to that point continues on a cache hit."

From later commit messages:

- **A ping, not a prompt.** The first version sent `.` as a real user message and then reverted it, which left `.` messages in history. The ping endpoint moves the marker without persisting anything.
- **Unrevert first.** On a second cache-safe revert, the old bookmark was still set, and the ping's path ran cleanup, which "permanently deletes messages from the first revert point onward, including the message the user clicked on." Clearing the bookmark first makes that cleanup a no-op.
- **`undo.revertFiles: false` skips git work.** Revert ran `git add . && git write-tree` and a full-worktree diff even when files would not be reverted; in large monorepos those operations hung and the revert request never completed.

## Code

- `packages/opencode/src/session/ping.ts`: `SessionPing.probe`
- `packages/opencode/src/provider/transform.ts`: `selectCacheMarkers` (probe branch)
- `packages/opencode/src/session/llm.ts`: probe index resolution in `LLM.stream`
- `packages/opencode/src/session/revert.ts`: `SessionRevert.revert`, `unrevert`, `cleanup`
- `packages/opencode/src/session/prompt.ts`: one-shot `cacheProbeMessageID` read and clear in the turn loop
- `packages/opencode/src/server/routes/session.ts`: `/:sessionID/ping`, session `PATCH`
- `packages/app/src/pages/session.tsx`: `revertHost.register` (the three-call flow)
- `packages/ui/src/components/message-part.tsx`: `RevertButton`
