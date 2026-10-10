# Server agent guidelines

## Test Commands

- **Typecheck**: `bun run typecheck`
- **Test**: `bun test` (all), `bun test test/tool/tool.test.ts` (one file)
- Running from source (`bun run --conditions=browser ./src/index.ts`) runs the
  checkout directly, not an installed binary.

## Conventions

- **Structure**: namespaces (`Tool.define()`, `Session.create()`), Zod schemas
  for every input, `Log.create({ service: "name" })`, `Storage` for persistence.
- **Context**: instance-scoped APIs run inside `Instance.provide`; pass
  `sessionID` through the tool context.
- **Tools**: implement `Tool.Info` with `execute()`. A failure throws, with a
  message naming what failed and where.
- **Server endpoints**: after adding or changing a route under `src/server/`,
  run `./script/generate.ts` to regenerate the SDK.
