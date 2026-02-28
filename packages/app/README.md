# Faber web UI

The SolidJS app the Faber server serves. `bun run --cwd packages/opencode build` builds it and embeds it in the `opencode` binary.

## Development

Start a server on port 4096 (e.g. `opencode serve --port 4096`), then run the Vite dev server:

```bash
bun run --cwd packages/app dev
```

It listens on port 3000 and talks to the server at `VITE_OPENCODE_SERVER_HOST`:`VITE_OPENCODE_SERVER_PORT` (default `localhost:4096`).

Unit tests: `bun test src`. Typecheck: `bun run typecheck`.

## E2E Testing

Playwright starts the Vite dev server automatically via `webServer`, and UI tests need a Faber server (defaults to `localhost:4096`).
Use the local runner to create a temp sandbox, seed data, and run the tests.

```bash
bunx playwright install
bun run test:e2e:local
bun run test:e2e:local -- --grep "settings"
```

Environment options:

- `PLAYWRIGHT_SERVER_HOST` / `PLAYWRIGHT_SERVER_PORT` (backend address, default: `localhost:4096`)
- `PLAYWRIGHT_PORT` (Vite dev server port, default: `3000`)
- `PLAYWRIGHT_BASE_URL` (override base URL, default: `http://localhost:<PLAYWRIGHT_PORT>`)
