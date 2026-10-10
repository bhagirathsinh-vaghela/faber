# Faber

A coding-agent server and web UI built for long sessions: the prompt cache keeps hitting, work survives restarts, and you can drive it by voice from a desktop or a phone.

Faber is my agent harness, built on top of OpenCode (see NOTICE). I use it daily.

**New here? Start with the [getting started guide](docs/getting-started.md).**

## Measured

From my own use over three months: 161,633 Anthropic requests, 2026-07-10 to 2026-10-10. The cache numbers hold month by month; the linked pages have the method and the breakdown.

| Metric                                                                      | Value                                                                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Input tokens served from cache                                              | [99.05%](docs/features/prompt-caching.md#measured), between 98.8% and 99.3% every month                             |
| Requests that rewrote the conversation cache mid-session                    | [0.08%](docs/features/prompt-caching.md#measured), never above 0.11% in a month, at a median request of 224k tokens |
| First request of a new session that read from cache                         | [77%](docs/features/prompt-caching.md#measured), and 99.2% for subagents                                            |
| Turns resumed after a 5 to 60 minute pause that found the cache warm        | [96%](docs/features/keep-warm.md#measured), between 95% and 98% every month                                         |
| Compaction input read from cache, since 2026-09-04                          | [96.7%](docs/features/compaction.md#measured), about 9x cheaper than a cold summary, over 67 compactions            |
| Shell commands that outlived the 5-second window and became background jobs | [8.9%](docs/features/background-jobs.md#measured) of 55,353, since the 5-second race shipped on 2026-09-02          |

## Highlights

**Cost**

- The prompt prefix stays byte-identical across turns, sessions, repos, plan/build switches, keep-warm pings and compaction. The system prompt is split by how often it changes, and the two stable blocks are cached for an hour. [Prompt caching](docs/features/prompt-caching.md)
- Compaction summarizes on the session's own cached prefix instead of rewriting it. [Compaction](docs/features/compaction.md)
- Reverting to an earlier message, or editing a prompt, continues on a cache hit. [Cache-safe revert](docs/features/cache-safe-revert.md)
- A per-session daemon re-sends the request just before the conversation's cache entry expires, so a session waiting on you or on a long tool call resumes on a cache hit. [Keep-warm](docs/features/keep-warm.md)
- Cost is computed on the server, with cache writes priced by lifetime. [Usage and cost](docs/features/usage-and-cost.md)

**Reliability**

- Every shell command is a durable job. It returns inline if it finishes within 5 seconds; otherwise it reports back when it ends, even if the server restarted in between. [Background jobs](docs/features/background-jobs.md)
- Subagents run in the background, start on the parent's cache, can inherit the parent conversation, and can be limited to a named tool preset. [Subagents](docs/features/subagents.md)
- After a restart or crash, interrupted turns resume and every owed result is delivered exactly once. A turn another live server is still running is left alone. [Restart recovery](docs/features/restart-recovery.md)
- A client that drops off (a phone going to sleep, a flaky network) replays what it missed on reconnect. [Real-time sync](docs/features/realtime-sync.md)

**Interface**

- Dictate into the composer from any device, with speech-to-text on your own machine, and have answers read aloud. [Voice](docs/features/voice.md)
- Reader mode, a session overview with Ctrl+Tab switching, a question picker the model actually uses, and an installable PWA for desktop, iPhone, iPad and Android. [Features](FEATURES.md)
- A supervisor page restarts the server from a phone, with no SSH. [Supervisor](docs/supervisor.md)

Every feature is listed in [FEATURES.md](FEATURES.md), with a deep dive per feature in [docs/features](docs/features).

## Beyond Anthropic

I use Anthropic models only, so the caching work is tuned to Anthropic's cache: four breakpoints per request, 5-minute and 1-hour lifetimes, and its read and write prices. Most of the ideas carry over to other providers:

| Idea                            | Automatic prefix caches (OpenAI, Gemini, DeepSeek, xAI, Kimi, GLM)                                                                                                   | Explicit breakpoints (Anthropic incl. Bedrock and Vertex, Qwen explicit, OpenAI GPT-5.6+) | Local servers (llama.cpp, vLLM, SGLang) |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------- |
| Byte-stable, append-only prefix | The main lever: a cached token costs 4x to 50x less than an uncached one                                                                                             | Same                                                                                      | Saves prefill time instead of money     |
| Compaction on the cached prefix | Applies                                                                                                                                                              | Applies                                                                                   | Applies (time)                          |
| Turn-boundary marker            | Not applicable                                                                                                                                                       | Applies                                                                                   | Not applicable                          |
| Keep-warm pings                 | Worth it only where entries expire within minutes (OpenAI's in-memory cache, Kimi K3's default); most others keep entries 30 minutes or more, or publish no lifetime | Worth it with a 5-minute lifetime (Anthropic, Qwen explicit)                              | No expiry, no use                       |

The system prompt goes out as up to three system messages, for every provider. llama.cpp with Qwen chat templates rejects that, and a Gemini user of an earlier two-block split reported the system prompt being ignored; Faber has no switch to merge them yet. Sources and details are in [prompt caching](docs/features/prompt-caching.md#other-providers).

## Quick start

Faber runs from source on macOS or Linux and needs [Bun](https://bun.sh) 1.3.11 and git.

```sh
git clone https://github.com/bhagirathsinh-vaghela/faber
cd faber
bun install
bun run --cwd packages/opencode build --single
export PATH="$PWD/packages/opencode/dist/opencode-$(uname -s | tr A-Z a-z)-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')/bin:$PATH"
export ANTHROPIC_API_KEY=sk-ant-...      # or: opencode auth login
opencode serve --port 4096               # web UI at http://127.0.0.1:4096
```

The [getting started guide](docs/getting-started.md) covers recommended settings, using it from a phone, voice, and running it next to an upstream OpenCode install.

## What Faber doesn't have

Faber forked OpenCode at v1.1.50 in February 2026 and has not merged upstream since. Compared with current OpenCode it lacks:

- the terminal UI and the desktop app (removed on purpose; see [why](#why-a-web-ui-and-no-terminal-ui));
- Windows support, and running on Node;
- the newer AI SDK (v6 in the last V1 release), and the provider integrations and per-model tuning added since the fork;
- compatibility with OpenCode V2 plugins and config;
- ACP editor integration, the GitHub Action, `opencode run`, and session sharing;
- the bug fixes upstream has shipped since the fork.

## Network exposure

The server and the supervisor listen on `127.0.0.1` by default. `--hostname 0.0.0.0` (or an interface address) exposes them, for example to reach the UI from a phone on a private network. Set `OPENCODE_SERVER_PASSWORD` before doing that: the server and the supervisor then both require basic auth. Without it they have no authentication, only a same-origin check on WebSockets and on the supervisor's restart and stop routes, and a Host check: requests are answered only when addressed to an IP address, `localhost` (or a `*.localhost` name), this machine's hostname and its `.local` form, the mDNS name when `--mdns` is on, or a host listed in `server.cors`. To reach Faber through a proxy under another name, set the password or add that origin to `server.cors` in the global `opencode.json` (`opencode serve` also takes `--cors`); the supervisor reads the same list.

## Why a web UI, and no terminal UI

The agent does all of its work in the server: it reads and edits files, runs commands, and talks to the model there. The UI is only a client that shows the conversation and takes your input, so nothing about the work ties it to a terminal. A terminal is a hard place to build that client: long transcripts, diffs, images, questions with options and many sessions side by side all fight its limits. A browser handles all of them, works the same on a desktop and a phone, and installs like an app. The web was the fastest way for me to build the client I wanted, so Faber drops the terminal UI and puts everything into the web UI.

## Differences from upstream OpenCode

|                        |                                                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Interface              | Web UI only, branded Faber ([why](#why-a-web-ui-and-no-terminal-ui)). The terminal UI and the desktop app were removed. The binary, config and data directories and env vars keep the `opencode` name.                                           |
| Session sharing        | Removed.                                                                                                                                                                                                                                         |
| Install                | From source only. The install script, `opencode upgrade` and `opencode uninstall` were removed.                                                                                                                                                  |
| Subscription logins    | No Claude Pro/Max login (current upstream has none either). ChatGPT, Copilot and GitLab logins are kept; the GitLab login plugin loads when a GitLab login is stored or the config lists the `gitlab` provider (`"provider": { "gitlab": {} }`). |
| OpenCode Zen           | Upstream's hosted models are still a provider you can add with a key, but they no longer load without one or act as the default model.                                                                                                           |
| Existing OpenCode data | Sessions keep working, but sessions created by upstream OpenCode are stored under its old project ids and do not show under their folder.                                                                                                        |

## Development

- Run from source without building: `bun dev serve --port 4096` (the web UI is served only after a build packs it).
- Tests: `bun test` inside `packages/opencode` and `packages/util`, `bun test src` inside `packages/app` (plain `bun test` there also picks up the Playwright specs), and `bun test --conditions=browser` inside `packages/ui`. The app's Playwright suite (`bun run test` in `packages/app`) needs `bunx playwright install` and a running server, and its round-trip spec needs `ANTHROPIC_API_KEY` or `OPENCODE_E2E_MODEL`.
- Typecheck: `bun turbo typecheck`. On a machine or VM with little memory, add `--concurrency=1`.

Licensed under Apache-2.0. See LICENSE and NOTICE.
