# Supervisor

The supervisor is for running Faber from a phone or tablet: it lets you start, restart and stop the server from a browser page, with no SSH session to the machine it runs on. If you always have a terminal on that machine, `opencode serve` alone is enough.

`opencode supervise` runs a small, separate process that owns the long-lived OpenCode server: it starts it, restarts it from a browser page with a health check, and stops it. Because the supervisor is its own process, killing or replacing the server never touches it. It is the fixed point that outlives every restart. Deciding which sessions to resume or pay after a restart is not the supervisor's job; the server does that from its own database (see [restart recovery](features/restart-recovery.md)).

## Running it

```sh
opencode supervise
```

| Flag           | Default     | Meaning                                                           |
| -------------- | ----------- | ----------------------------------------------------------------- |
| `--port`       | `4099`      | Port the supervisor page and API listen on                        |
| `--serve-port` | `4097`      | Port of the server the supervisor owns                            |
| `--stage-port` | `4098`      | Port a new build is staged and health-checked on during a restart |
| `--hostname`   | `127.0.0.1` | Interface both the supervisor and its server listen on            |

On start, the supervisor checks `GET /global/health` on the serve port. If nothing healthy answers, it boots the server itself, so a machine that just rebooted needs no browser round-trip. If a healthy server is already there (for example, the supervisor itself was restarted to pick up new supervisor code), it leaves that server running.

If the server it owns exits without being stopped (a crash, an out-of-memory kill), the supervisor starts it again through the same staged, health-checked restart. A server that exits unexpectedly more than three times within a minute is left down, with a log line saying so, rather than restarted in a loop; pressing Restart starts the count over. Stop never triggers a restart. A server the supervisor adopted at startup (one already healthy on the port) is not watched until the next restart takes ownership of it. To survive a reboot, run `opencode supervise` itself under launchd or systemd; each time it starts, it boots the server if nothing healthy answers.

The server is launched from the same code as the supervisor: the compiled binary re-executes itself as `opencode serve --port <port> --hostname <host>`, and a source run replays its entry script through Bun. A running supervisor keeps executing the code it started with even after the binary on disk is replaced; restart the supervisor to pick up supervisor changes.

## HTTP routes

| Route           | Effect                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `GET /`         | The supervisor page: status, Start/Restart, Stop and Open buttons                                  |
| `GET /status`   | `{ port, owned, pid, health }`, where `health` is the server's `/global/health` response or `null` |
| `POST /restart` | Stage, health-check and cut over (below). From cold, this is the Start button                      |
| `POST /stop`    | Kill the owned server and any leftover listener it launched; the supervisor stays up               |

`POST` requests whose `Origin` header names a different host are refused with 403 (`Origin.foreign`). Requests with no `Origin` header (curl, scripts) pass the origin check. When `OPENCODE_SERVER_PASSWORD` is set, every route, the page included, also requires HTTP basic auth (see Network exposure); without it there is no other authentication.

The page refreshes `/status` every 3 seconds. The Open button links to the server on the same host at the serve port, or to `uiUrl` from the config file when set.

## Restart flow

`restart()` never touches the live server until a new build has proven it can serve:

1. **Stage.** Clear the stage port, launch `opencode serve` on it, and wait for the child to be alive, answer `/global/health`, and hold the listening socket itself (`waitOwned`). If it never gets there, kill it and report `{ ok: false, step: "stage" }`. The live server is untouched.
2. **Drop the stage, stop the live server.** Kill the staged process, then the owned server through its process handle.
3. **Cut over.** Confirm the serve port is free (`reapOrphan`), launch the server on it with `OPENCODE_LIVE=1`, and wait for it to pass the same ownership check. Failure reports `{ ok: false, step: "cutover" }`.
4. Return `{ ok: true, health }`.

`OPENCODE_LIVE=1` tells the new server it is the live one, so it starts recovery at once instead of after the 60-second boot grace: cut turns resume and warm sessions re-arm immediately. The staged build never gets the flag and is killed before its grace expires, so it never acts on live sessions.

The restart confirmation on the page warns that every cut turn resumes. Stop any session you do not want resumed before restarting.

### Orphans and port checks

`reapOrphan` finds the processes listening on a port (`ss -ltnHp` on Linux, `lsof` elsewhere and on Linux without `ss`) and kills only those whose command line has the `serve --port <port>` shape the supervisor launches (`launched`). Any other listener is left alone and the restart fails with `port <n> is held by a process this supervisor did not launch`. Owned holders get SIGTERM, SIGKILL after 5 seconds, and the attempt gives up after 10.

The ownership check in `waitOwned` exists because a health answer alone is not proof: if the new child loses the bind race and dies, an orphan still holding the port answers health, and the restart would report success while stale code serves.

## Network exposure

The default `127.0.0.1` keeps both the supervisor and the server reachable only from the same machine. `--hostname 0.0.0.0` exposes both to the network, and the health probe then uses `127.0.0.1` internally.

Before exposing the server, set `OPENCODE_SERVER_PASSWORD` (and optionally `OPENCODE_SERVER_USERNAME`, default `opencode`). The server then requires HTTP basic auth on every route, and `opencode serve` prints a warning when the variable is unset.

The supervisor reads the same variables. With a password set, its page and routes (`/status`, `POST /restart`, `POST /stop`) ask for the same credentials, and its health probe sends them to the server.

## Configuration

Optional file: `supervisor.json` in the global config directory (`$XDG_CONFIG_HOME/opencode/`, usually `~/.config/opencode/`).

| Key     | Meaning                                                                                                                                  |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `uiUrl` | Browser-facing URL for the Open button, for when a proxy or tunnel serves the UI on a different scheme, host or port than the serve port |

```json
{ "uiUrl": "https://opencode.example.internal" }
```

The file is read once when the supervisor starts.

## Relation to restart recovery

The supervisor owns processes only. It does not track sessions, replay prompts or deliver results. Every restart path ends the same way: a fresh `opencode serve` reads the database, takes the recovery lease and resumes cut turns, pays owed results and re-arms warm sessions. That also happens after a crash or reboot with no supervisor involved; the supervisor only shortens the wait (via `OPENCODE_LIVE`) and keeps a bad build from replacing a good one.

There is no reload button: session prompt state is pinned by content hash, so new sessions always see current files and nothing needs manual publishing.

## Why

- **No SSH from a phone.** An outer process that owns the server lets it be restarted from a browser with no terminal, revives it after a crash, and killing the server never touches the supervisor (`supervise.ts` header).
- **Stage before cutover.** A build that fails to boot is caught on the stage port while the live server keeps serving.
- **Runs from the installed build.** The supervisor needs no repository checkout; it relaunches whatever binary or entry script started it.

## Requirements

- Linux: `ss` (from iproute2) or `lsof`, and `ps`.
- macOS: `lsof` and `ps`, both present on a stock install.

## Code

- `packages/opencode/src/cli/cmd/supervise.ts`: `SuperviseCommand`, `restart`, `reapOrphan`, `waitOwned`, `launched`, `listeners`, `credentials`, `admitted`, `watch`, `crashLoop`
- `packages/opencode/src/cli/cmd/serve.ts`: `ServeCommand`, `OPENCODE_LIVE`
- `packages/opencode/src/server/origin.ts`: `Origin.foreign`
- `packages/opencode/src/server/server.ts`: basic auth middleware (`OPENCODE_SERVER_PASSWORD`)
- `packages/opencode/src/session/recovery.ts`: `Recovery.init`, `GRACE_MS`
