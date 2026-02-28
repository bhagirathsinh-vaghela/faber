# Faber server and CLI

Builds the `opencode` binary: the server, the supervisor and the CLI, with the web UI from `packages/app` embedded.

```bash
bun run build                 # binaries in dist/
bun run dev serve --port 4096 # run from source
bun test                      # all tests
bun run typecheck
```

Set `OPENCODE_SKIP_PACK_WEB=1` to reuse the last web UI build when only server code changed.
