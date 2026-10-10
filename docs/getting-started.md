# Getting started

From a fresh clone to a working session, then the settings worth turning on.

## 1. Build

Needs macOS or Linux, [Bun](https://bun.sh) 1.3.11 and git.

```sh
git clone https://github.com/bhagirathsinh-vaghela/faber
cd faber
bun install
bun run --cwd packages/opencode build --single
```

The binary lands in `packages/opencode/dist/opencode-<os>-<arch>/bin/opencode`, with the web UI packed inside it. Put that directory on your `PATH`:

```sh
export PATH="$PWD/packages/opencode/dist/opencode-$(uname -s | tr A-Z a-z)-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')/bin:$PATH"
```

## 2. Add a provider

Either export a key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...) or store one with:

```sh
opencode auth login
```

Faber is built and tested with Anthropic models; see [Beyond Anthropic](../README.md#beyond-anthropic) for what applies elsewhere.

## 3. Start the server and open a project

```sh
opencode serve --port 4096
```

Open `http://127.0.0.1:4096`, choose **Open project** and pick a folder, then choose a model and send a prompt. The agent works in that folder; every session, job and result lives in the server, so closing the tab loses nothing.

## 4. Recommended settings

Global config lives in `~/.config/opencode/opencode.json`. These are the settings I would turn on first:

```json
{
  "ping": { "enabled": true },
  "compaction": { "threshold": 0.85 },
  "background": { "job": { "hard_timeout": "1h" } }
}
```

| Key                           | Effect                                                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ping.enabled`                | Keep-warm: refresh the conversation's cache entry before it expires, while a session waits. Off by default. Pings never stop on their own, so Stop a session you are leaving for more than about an hour. [Details](features/keep-warm.md) |
| `compaction.threshold`        | Compact at this share of the context window, leaving room for the summary. [Details](features/compaction.md)                                                                                                                               |
| `background.job.hard_timeout` | Kill a shell command after this long (default `30m`). [Details](features/background-jobs.md)                                                                                                                                               |

For settings that should not be committed, `opencode.local.json` (beside `opencode.json`, globally or in a project) and `AGENTS.local.md` (globally or in a project) layer over the committed files. Faber does not gitignore them, so add them to your `.gitignore`. [Details](features/skills-and-config.md)

## 5. Use it from a phone or tablet

Run the supervisor instead of `opencode serve`. It owns the server, revives it after a crash, and gives you a page to start, restart and stop it from a browser, with no SSH:

```sh
export OPENCODE_SERVER_PASSWORD=...   # required once you listen beyond localhost
opencode supervise --hostname 0.0.0.0 # page on :4099, server on :4097
```

- Open `http://<machine>:4097` on the phone and sign in with user `opencode` and the password.
- Installing it as an app needs HTTPS. Put the server behind an HTTPS proxy (Caddy, Tailscale Serve, ...) and either keep the password or add the proxy's origin to `server.cors` in the global config, because requests to an unknown host name are refused when no password is set.
- To start Faber on boot, run `opencode supervise` under launchd or systemd.

[Supervisor reference](supervisor.md) · [Network exposure](../README.md#network-exposure) · [Mobile and PWA](features/mobile-and-pwa.md)

## 6. Voice (optional)

Dictation and read-aloud talk to a local speech server at `http://127.0.0.1:4111` (`dictation.url` in config). None ships with Faber; anything that serves the [sidecar API](speech-sidecar.md) works. Without one, the microphone and speaker buttons say the sidecar is unreachable. [Voice](features/voice.md)

## 7. Running next to upstream OpenCode

Faber keeps the `opencode` name for its binary, config and data directories, so by default it shares `~/.config/opencode` and `~/.local/share/opencode` with an upstream install. To keep them apart, give Faber its own XDG directories:

```sh
export XDG_CONFIG_HOME=~/.faber/config XDG_DATA_HOME=~/.faber/data XDG_STATE_HOME=~/.faber/state XDG_CACHE_HOME=~/.faber/cache
opencode serve --port 4096
```

Commands the agent runs inherit these variables, so other XDG-aware tools (such as `gh`) will look there too; set them in the shell that starts Faber, not your login profile. Sessions live in `$XDG_DATA_HOME/opencode/storage/storage.db`, logs in `$XDG_DATA_HOME/opencode/log`.

## Updating

```sh
git pull && bun install && bun run --cwd packages/opencode build --single
```

Then restart: Ctrl+C and `opencode serve` again, or **Restart** on the supervisor page, which stages the new build and health-checks it before cutting over. Interrupted turns resume after either.

## Troubleshooting

| Symptom                                          | Cause and fix                                                                                                        |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `403 unrecognized Host header`                   | Reached through a name the server does not know. Add the origin to `server.cors`, or set `OPENCODE_SERVER_PASSWORD`. |
| `Warning: OPENCODE_SERVER_PASSWORD is not set`   | Fine on `127.0.0.1`. Set it before using `--hostname 0.0.0.0`.                                                       |
| The UI shows no models                           | No provider key. Export one or run `opencode auth login`, then reload.                                               |
| The microphone says the sidecar is unreachable   | No speech server at `dictation.url`. See [Voice](#6-voice-optional).                                                 |
| Supervisor restart fails with `port <n> is held` | Another process holds the serve or stage port. Stop it, or pick other ports with `--serve-port` and `--stage-port`.  |
