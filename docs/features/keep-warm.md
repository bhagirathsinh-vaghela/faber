# Keep-warm

Anthropic's conversation cache entries live for five minutes. A session waiting on you, a long build, or a tool call that runs past that window would otherwise resume on a full cache rewrite. With keep-warm enabled, a per-session daemon re-sends the session's exact request a few seconds before the entry expires, which refreshes it. The ping persists no message and runs no tools, but its tokens and cost are counted like any other request.

> **Provider scope.** Pings are sent for any model, but the timing is built for Anthropic's 5-minute cache lifetime, which a request refreshes. With a provider whose cache works differently, or has no cache, a ping costs a request and buys nothing; leave `ping.enabled` off there.

## How it works

### The anchor and the deadline

Every dispatched request (a turn step or a ping) records its dispatch time on the session as `cache.lastRequestAt`. The daemon derives everything from that anchor:

```text
ping at = lastRequestAt + 5 min - ping.before_expiry
```

`SessionPing` runs one loop per armed session. On each pass, `evaluate` returns one of three decisions:

| Decision | When                                                                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ping`   | The anchor is inside the 5-minute window. The loop sleeps until the deadline, re-checks, and pings if still due.                                                                  |
| `idle`   | No request has been dispatched yet, the window has already lapsed, too many consecutive pings missed, or the session could not be read. The loop sleeps 10 seconds and re-checks. |
| `stop`   | The session is a subagent. The loop exits.                                                                                                                                        |

The anchor decides, not whether a turn is running. A turn that keeps dispatching requests keeps pushing the deadline out, so the daemon stays quiet. A turn parked inside a long tool call dispatches nothing, the deadline arrives, and the ping fires. That is the case it exists for. A ping that overlaps a turn's own request costs one duplicate cache read.

### The ping request

`ping` rebuilds the request the next turn would send: the same history (after compaction filtering and plugin transforms), the same agent resolved from the session's pin, the same tools and the same three system blocks. It appends one user message, `.`, and calls `LLM.stream`. The cache markers therefore land where a real turn would put them (see [prompt caching](prompt-caching.md)).

The ping reads the stream until the first `finish-step`, then records usage with `Session.updateTotals`, priced by the same function as a turn (see [usage and cost](usage-and-cost.md)). It writes no message. Only the turn loop persists message state, so a ping that overlaps a turn cannot write a stale copy of history over it.

### Bounds

| Guard          | Value | Behaviour                                                                                                                                             |
| -------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PING_TIMEOUT` | 60 s  | Aborts a single stalled ping without ending the loop.                                                                                                 |
| `MAX_MISSES`   | 2     | A ping that never sees `start-step` (the server streamed nothing) is a miss. After two in a row the daemon stays idle until the next turn re-arms it. |
| `MIN_TICK`     | 1 s   | Floor under a due ping's sleep, so a deadline that never moves cannot spin the loop.                                                                  |
| `IDLE_TICK`    | 10 s  | Re-check interval while there is nothing to ping.                                                                                                     |

Seeing `start-step` counts as success: the server accepted the request and read the cached prefix, even if the body later errors.

### Intent: who arms and who disarms

Each session persists a `keepWarm` flag that mirrors whether a daemon is armed. Only explicit actions change it:

| Action                                                                          | Effect                                                                                                                                     |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Sending a prompt, or a result delivered into the session                        | Arms at turn start (`SessionPing.start`). A busy turn keeps sliding the deadline, so arming early costs no ping.                           |
| Opening a session from the sidebar or overview (`POST /session/:sessionID/arm`) | Arms, but only while the cache is still inside its window.                                                                                 |
| Stop, archive, delete                                                           | Disarms and clears `keepWarm` (`Session.stop`, `SessionPing.stop`).                                                                        |
| Interrupting a turn (Esc)                                                       | Leaves `keepWarm` set.                                                                                                                     |
| A plain fetch: reload, reconnect, a second client attaching                     | Reconciles to the stored flag. It re-arms only a session that already has `keepWarm` and a live cache, and never resurrects a stopped one. |

Subagent and headless sessions are never kept warm (`Session.attended`).

After a server restart, recovery re-arms every session that carries `keepWarm` and whose anchor is still inside the 5-minute window (`Recovery`, `arm`). A machine that was down longer restores nothing.

### In the UI

The session status line and the session overview show a countdown ring to the next ping. A session with no scheduled ping (stopped, disabled, or its window lapsed) shows `--` and an empty ring. The server publishes the deadline (`pingAt`) and the clients only render it, so every surface agrees.

## Configuration

| Key                  | Default | Effect                                                                                                                                                                                             |
| -------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ping.enabled`       | `false` | Turns the daemon on. When off, turns still re-anchor the window but no daemon is armed, so no automatic ping fires and the countdown shows `--`. Cache-safe revert still sends its one-shot probe. |
| `ping.before_expiry` | `10`    | Seconds before expiry to send the ping.                                                                                                                                                            |

```json
{
  "ping": { "enabled": true, "before_expiry": 10 }
}
```

HTTP: `POST /session/:sessionID/arm` arms a session that is still warm; `POST /session/:sessionID/ping` sends a one-shot ping, optionally with a cache probe (see [cache-safe revert](cache-safe-revert.md)).

## Why

The daemon replaced manual `.` keep-alive messages that had to be sent and then cleaned out of history; the daemon persists nothing. The remaining design follows from bugs recorded in commit messages:

- **Pinging through a busy turn.** The daemon once stood down while a turn was running. A turn stuck in a long tool call moves no anchor, so the window lapsed while the daemon slept, and "a wedged tool call cost the whole cache rather than one ping".
- **The 60-second deadline.** One ping stalled for 16 minutes after a network drop. Healthy pings took 1.7 to 39 seconds, so 60 seconds bounds a stall without clipping a live ping, and stays far below the 5-minute TTL.
- **The sleep floor.** A ping that returned before dispatching left the deadline already due, so the loop rebuilt the whole session history back to back: "18,420 file reads and 235MB of transient copies per pass", at 100% CPU.
- **Only the turn persists.** A ping read the history, a turn finished in the meantime, and the ping wrote its stale copy back, un-finishing the turn. The next request ended in two assistant blocks and the API rejected it. This affected "one damaged record in 23,542 on one machine and one in 31,222 on another".
- **Persisted intent.** Opening a session used to re-arm it, so a second client's reload revived a session another client had just stopped. Arming now follows explicit actions, and passive attaches reconcile to the stored flag.
- **Restore gated on cache liveness.** After a reboot, "a machine down longer restores nothing, which is right when there is no warm cache left to defend."

## Code

- `packages/opencode/src/session/ping.ts`: `SessionPing.start`, `stop`, `probe`, `warm`, `evaluate`, `pause`, `ping`, `classify`, `CACHE_TTL`, `PING_TIMEOUT`, `MAX_MISSES`
- `packages/opencode/src/session/prompt.ts`: the `SessionPing.start` call at turn start
- `packages/opencode/src/session/index.ts`: `Session.stop`, `Session.attended`
- `packages/opencode/src/session/recovery.ts`: `arm` (restart re-arm)
- `packages/opencode/src/server/routes/session.ts`: `/:sessionID/arm`, `/:sessionID/ping`, attach reconcile in the session `GET` route
- `packages/app/src/utils/cache-countdown.ts`: `pingCountdown`
- `packages/app/src/components/statusline.tsx`, `packages/app/src/components/dialog-overview.tsx`: countdown rings
