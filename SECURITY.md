# Security

## What Faber exposes

Faber always runs as a server, bound to `127.0.0.1` by default, so only your own machine can reach it.

`--hostname` (or `--mdns`, or `server.hostname` in config) exposes it to other machines. Set `OPENCODE_SERVER_PASSWORD` before you do that: the server and the supervisor then require HTTP basic auth. Without it, the only protection is a same-origin check on WebSocket connections and supervisor POST requests, and a Host check: the server and the supervisor answer only an IP address, `localhost` (or a `*.localhost` name), this machine's hostname and its `.local` form, the mDNS name when mDNS is on, or a host listed in `server.cors`. That keeps a web page whose DNS name is pointed at your machine from reaching them, unless the page uses one of those names.

## No sandbox

The agent runs shell commands and edits files with your user's permissions. The permission prompts keep you aware of what it does; they are not isolation. If you need isolation, run Faber in a container or VM.

## Reporting a vulnerability

Use "Report a vulnerability" on this repository's [Security tab](https://github.com/bhagirathsinh-vaghela/faber/security) rather than a public issue.
