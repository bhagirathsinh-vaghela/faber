# Usage and cost

The server computes token, cache and dollar figures for every request, per message and as running session totals. Cache writes are priced by their TTL (1h at 2x base input, 5m at 1.25x), and prices can be overridden in config. The web UI shows the figures as a row of chips in the session dock and under each answer, with a field layout stored on the server and shared by every client.

> **Provider scope.** Token and dollar figures work for any model with known prices. The split of cache writes by lifetime and the weighted session input use Anthropic's cache price multipliers (reads 0.1x, 5-minute writes 1.25x, 1-hour writes 2x).

## How it works

### Reading usage

At each `finish-step`, `Session.getUsage` turns the provider's usage report into token counts: uncached input, output, reasoning, cache read and cache write. For Anthropic it also reads the TTL split of cache writes (`cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`) from the raw usage body. This split matters because [prompt caching](prompt-caching.md) marks system blocks with a 1h TTL and conversation blocks with a 5m TTL.

### Pricing

`SessionPricing` is the only code that turns tokens into dollars. Both the per-message cost and the session total go through `SessionPricing.cost`, so they cannot disagree.

Rates are resolved per model:

| Source                                    | When used                                                                                                                                                                                                       |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pricing["<provider>/<model>"]` in config | First, when present. All five rates come from config.                                                                                                                                                           |
| models.dev                                | Otherwise. Its single cache-write figure is the 5m rate. The 1h rate is derived as 2x base input. Above 200k tokens of input plus cache reads, the model's long-context tier is used when models.dev lists one. |

The cost of one step:

```text
cost = input        x rate.input
     + output       x rate.output
     + reasoning    x rate.output
     + cache read   x rate.cacheRead
     + 5m writes    x rate.cacheWrite5m
     + 1h writes    x rate.cacheWrite1h
```

All rates are dollars per million tokens, and the arithmetic uses `decimal.js`. Reasoning tokens are billed at the output rate because models.dev prices no separate bucket. When a provider reports no TTL split, all cache writes are priced at the 5m rate.

### Where the numbers are stored

| Record            | Holds                                                                                                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Assistant message | `tokens` for the step and the accumulated `cost` for the message                                                                                                                                     |
| Session `tokens`  | The latest step's counts, used for the context gauge                                                                                                                                                 |
| Session `total`   | Running totals: `input` (cache tokens weighted by their price multiplier: reads 0.1x, 5m writes 1.25x, 1h writes 2x; uncached input is not included), `output` (output plus reasoning), `cacheWrite` |
| Session `cost`    | Running dollar total                                                                                                                                                                                 |

Each step's totals and cost are also added to the parent session's totals, so a session's figures include the subagents it spawned. [Keep-warm](keep-warm.md) pings are real API requests and update the same session totals with the same pricing function, though they create no message.

Totals are written with `Session.updateTotals`, which broadcasts a small `TotalsUpdated` event instead of the full session record on every step.

### In the web UI

`UsageLine` renders the figures as chips in three groups:

| Group     | Chips                                                                                                                                                                  |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context   | A gauge of context used against the model's context limit; the fill turns from the start colour to the end colour at 75%. In the live dock it opens the context panel. |
| This turn | Tokens read from cache, tokens written to cache, output tokens (which join the next turn's context)                                                                    |
| Session   | Session input, session output, session cache write, cost                                                                                                               |

The live dock shows the current session; each assistant message footer shows a snapshot of the same chips for that message. The dock can also lead with the [keep-warm](keep-warm.md) countdown chip.

### Dock layout

Which fields appear is a server-side setting, stored as `dock.json` in the global state directory. It holds two independent sets of visible field ids, `desktop` and `mobile`; the app picks one by screen width. Render order is fixed in code, so hiding a field never reorders the rest. The "customize fields" dialog (`DialogDock`) edits the sets, and every write broadcasts a `dock.updated` event so all open clients update at once.

With no file, desktop shows every field and mobile shows agent, model, working directory, branch, context, cost, MCP and review. The file records which field ids existed when it was written, so a field added in a later release appears by default instead of reading as hidden.

## Configuration

| Key                               | Effect                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pricing`                         | Map of `provider/model` to `{ input, output, cacheRead, cacheWrite5m, cacheWrite1h }` in dollars per million tokens. Takes precedence over models.dev. |
| `anthropic.context.<model>.cost`  | Per-model `input`, `output`, `cacheRead`, `cacheWrite` overrides applied when the Anthropic model is loaded.                                           |
| `anthropic.context.<model>.limit` | Context window limit used for the gauge and compaction decisions.                                                                                      |

```json
{
  "pricing": {
    "anthropic/claude-opus-5": {
      "input": 5,
      "output": 25,
      "cacheRead": 0.5,
      "cacheWrite5m": 6.25,
      "cacheWrite1h": 10
    }
  }
}
```

The figures above are an illustration of the multipliers, not a published price list.

HTTP: `GET /dock/config` and `PUT /dock/config` read and write the dock layout.

## Why

From commit messages and config descriptions:

- **TTL-aware pricing.** Both cost formulas once applied a single blended write rate, "so the largest bucket was billed at the cheaper one and a system-heavy turn under-reported by about 37%."
- **One pricing module.** The displayed session total came from a hardcoded tier table matched by model-id substring, while the per-message cost came from models.dev, and the two diverged on reasoning tokens, the over-200k tier, non-Anthropic providers and config overrides. An unmatched model id priced at zero.
- **Prices in config.** "Lives in config so prices can be corrected without shipping a new binary" (the `pricing` key's description).
- **Server-side dock layout,** "so one layout follows the user across every session, browser, and device."
- **Subagent costs roll up.** Previously only the child session's own total was updated, so the parent's totals excluded subagent API costs.

## Code

- `packages/opencode/src/session/pricing.ts`: `SessionPricing.rates`, `SessionPricing.cost`, `SessionPricing.weightedInput`
- `packages/opencode/src/session/index.ts`: `Session.getUsage`, `Session.updateTotals`
- `packages/opencode/src/session/processor.ts`: `finish-step` handling, parent roll-up
- `packages/opencode/src/session/ping.ts`: ping usage accounting
- `packages/opencode/src/dock/dock.ts`: `Dock.get`, `Dock.set`, `Dock.defaults`
- `packages/opencode/src/server/server.ts`: `/dock/config` routes
- `packages/app/src/components/usage-line.tsx`: `UsageLine`, `statsFromMessage`
- `packages/app/src/components/message-footer.tsx`, `packages/app/src/components/statusline.tsx`, `packages/app/src/components/dialog-dock.tsx`
- `packages/ui/src/components/chip.tsx`: `Chip`, `ChipGroup`
