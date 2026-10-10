# Faber

Run a fleet of coding agents from any browser, even on mobile. Prompt caches stay hot across repo switches and compaction.

Faber is my agent harness, built on top of OpenCode (see NOTICE). I use it daily.

What it adds:

- Durable background jobs and subagents whose results arrive exactly once, even across restarts.
- Prompt caching that survives repo switches and compaction: about 99% of Anthropic input tokens are served from cache (99.05% over 176,856 requests, July to October 2026; see [how it is measured](docs/features/prompt-caching.md)).
- MCP tool schemas loaded on demand instead of sent with every request.
- A web UI built for running many sessions at once, from a desktop or a phone.

Every feature is listed in [FEATURES.md](FEATURES.md), with a deep dive per feature in [docs/features](docs/features).

> **Built on Anthropic.** I use Anthropic models exclusively, so the caching and cost work is built around Anthropic's prompt cache: at most four cache breakpoints per request, 5-minute and 1-hour entry lifetimes, and its cache-read and cache-write prices. The principles carry over to any provider with prefix caching: keep the prompt prefix byte-stable, append instead of editing, keep the cache warm while waiting, and show what each turn costs. The mechanisms differ, though, and with other providers several of these features do less or nothing. Each feature page says where this applies.

## Quick start

Faber runs from source. It needs [Bun](https://bun.sh) 1.3.11, git, and macOS or Linux (Windows is not supported).

```sh
git clone https://github.com/bhagirathsinh-vaghela/faber
cd faber
bun install
bun run --cwd packages/opencode build --single
```

The binary lands in `packages/opencode/dist/opencode-<os>-<arch>/bin/opencode`. Put it on your `PATH`, give it a provider key, then start the server and open the printed URL:

```sh
export PATH="$PWD/packages/opencode/dist/opencode-$(uname -s | tr A-Z a-z)-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')/bin:$PATH"
export ANTHROPIC_API_KEY=sk-ant-...      # or: opencode auth login
opencode serve --port 4096               # web UI at http://127.0.0.1:4096
```

If you will use Faber from a phone or tablet, run the supervisor instead: `opencode supervise` (page on port 4099, server on 4097). It lets you start, restart and stop the server from the browser, with no SSH session to the machine. See [the supervisor reference](docs/supervisor.md).

Anthropic is reached with an API key, like every other provider. Faber ships no subscription login.

## Network exposure

The server and the supervisor listen on `127.0.0.1` by default. `--hostname 0.0.0.0` (or an interface address) exposes them, for example to reach the UI from a phone on a private network. Set `OPENCODE_SERVER_PASSWORD` before doing that: the server and the supervisor then both require basic auth. Without it they have no authentication, only a same-origin check on WebSockets and on the supervisor's restart and stop routes.

## Voice

Dictation and read-aloud talk to a local speech sidecar at `http://127.0.0.1:4111` (`dictation.url` in config). No sidecar ships with Faber; anything that serves the [sidecar wire API](docs/speech-sidecar.md) works. Without one, the microphone and speaker buttons report that the sidecar is unreachable.

## Why a web UI, and no terminal UI

The agent does all of its work in the server: it reads and edits files, runs commands, and talks to the model there. The UI is only a client that shows the conversation and takes your input, so nothing about the work ties it to a terminal. A terminal is a hard place to build that client: long transcripts, diffs, images, questions with options and many sessions side by side all fight its limits. A browser handles all of them, works the same on a desktop and a phone, and installs like an app. The web was the fastest way for me to build the client I wanted, so Faber drops the terminal UI and puts everything into the web UI.

## Differences from upstream OpenCode

|                        |                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Interface              | Web UI only, branded Faber ([why](#why-a-web-ui-and-no-terminal-ui)). The terminal UI and the desktop app were removed. The binary, config and data directories and env vars keep the `opencode` name. |
| Session sharing        | Removed.                                                                                                                                                                                               |
| Install                | From source only. The install script, `opencode upgrade` and `opencode uninstall` were removed.                                                                                                        |
| Subscription logins    | Claude Pro/Max login removed; ChatGPT, Copilot and GitLab logins kept. The GitLab login plugin loads only when the config lists the `gitlab` provider (`"provider": { "gitlab": {} }`).                |
| OpenCode Zen           | Upstream's hosted models are still a provider you can add with a key, but they no longer load without one or act as the default model.                                                                 |
| Existing OpenCode data | Sessions keep working, but sessions created by upstream OpenCode are stored under its old project ids and do not show under their folder.                                                              |

## Development

- Run from source without building: `bun dev serve --port 4096` (the web UI is served only after a build packs it).
- Tests: `bun test` inside `packages/opencode` and `packages/util`, `bun test src` inside `packages/app` (plain `bun test` there also picks up the Playwright specs), and `bun test --conditions=browser` inside `packages/ui`. The app's Playwright suite (`bun run test` in `packages/app`) needs `bunx playwright install` and a running server, and its round-trip spec needs `ANTHROPIC_API_KEY` or `OPENCODE_E2E_MODEL`.
- Typecheck: `bun turbo typecheck`. On a machine or VM with little memory, add `--concurrency=1`.

Licensed under Apache-2.0. See LICENSE and NOTICE.
