import { Decimal } from "decimal.js"
import { Config } from "@/config/config"
import type { Provider } from "@/provider/provider"

// Single source of truth for turning token counts into dollars. Both the
// per-message cost and the running session total go through here, so the two
// can never disagree.
export namespace SessionPricing {
  // Anthropic prices a cache write by its TTL, as a multiple of the base input
  // rate: 1h costs 2x, 5m costs 1.25x. models.dev carries a single cache_write
  // number (the 5m rate), so the 1h rate is derived rather than read.
  // https://platform.claude.com/docs/en/build-with-claude/prompt-caching
  const WRITE_1H_MULTIPLIER = 2
  const WRITE_5M_MULTIPLIER = 1.25
  const READ_MULTIPLIER = 0.1

  export interface Rates {
    input: number
    output: number
    cacheRead: number
    cacheWrite5m: number
    cacheWrite1h: number
  }

  export interface Tokens {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
      // Per-TTL split, when the provider reported one. Undefined means unknown,
      // not zero: the whole write total is then priced at the blended 5m rate.
      write5m?: number
      write1h?: number
    }
  }

  // Config first so a wrong price can be corrected by editing config, with no
  // new binary. models.dev covers everything not listed there.
  export async function rates(model: Provider.Model, overThreshold: boolean): Promise<Rates> {
    const configured = (await Config.get()).pricing?.[`${model.providerID}/${model.id}`]
    if (configured) return configured

    const cost = overThreshold && model.cost.experimentalOver200K ? model.cost.experimentalOver200K : model.cost
    return {
      input: cost.input,
      output: cost.output,
      cacheRead: cost.cache.read,
      // models.dev carries ONE flat cache_write for every model and every
      // provider; no TTL granularity exists anywhere in that feed. Across all 15
      // Anthropic models it is exactly 1.25x input, i.e. always the 5m rate.
      cacheWrite5m: cost.cache.write,
      // The 1h rate is therefore derived, not fetched. That is exact rather than
      // approximate: Anthropic prices a 1h write at a fixed 2x base input, and
      // the API reports how many tokens went to each TTL
      // (cache_creation.ephemeral_5m/1h_input_tokens), so a model with no config
      // entry still prices correctly from models.dev alone.
      // Guard: if input is unpriced, fall back to the 5m number rather than
      // inventing a rate, which keeps a zero-priced model at zero.
      cacheWrite1h: cost.input > 0 ? cost.input * WRITE_1H_MULTIPLIER : cost.cache.write,
    }
  }

  // Split the write total by TTL when the provider reported one. Without a
  // breakdown, everything counts as 5m, matching the old blended behavior.
  function writes(tokens: Tokens) {
    if (tokens.cache.write1h === undefined && tokens.cache.write5m === undefined)
      return { write5m: tokens.cache.write, write1h: 0 }
    return { write5m: tokens.cache.write5m ?? 0, write1h: tokens.cache.write1h ?? 0 }
  }

  export async function cost(model: Provider.Model, tokens: Tokens): Promise<number> {
    // The >200K tier is keyed on what was actually sent, so cached reads count
    // toward the threshold alongside fresh input.
    const rate = await rates(model, tokens.input + tokens.cache.read > 200_000)
    const { write5m, write1h } = writes(tokens)

    const total = new Decimal(0)
      .add(new Decimal(tokens.input).mul(rate.input).div(1_000_000))
      .add(new Decimal(tokens.output).mul(rate.output).div(1_000_000))
      .add(new Decimal(tokens.cache.read).mul(rate.cacheRead).div(1_000_000))
      .add(new Decimal(write5m).mul(rate.cacheWrite5m).div(1_000_000))
      .add(new Decimal(write1h).mul(rate.cacheWrite1h).div(1_000_000))
      // models.dev prices no reasoning bucket, and providers bill reasoning as
      // output, so charge it at the output rate.
      .add(new Decimal(tokens.reasoning).mul(rate.output).div(1_000_000))
      .toNumber()

    return Number.isFinite(total) ? total : 0
  }

  // Cache tokens expressed as their input-token equivalent, for the running
  // session total that tracks context weight rather than dollars. Same
  // multipliers the pricing above uses, so the two can't drift.
  export function weightedInput(tokens: Tokens): number {
    const { write5m, write1h } = writes(tokens)
    return tokens.cache.read * READ_MULTIPLIER + write5m * WRITE_5M_MULTIPLIER + write1h * WRITE_1H_MULTIPLIER
  }
}
