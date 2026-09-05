import type { NamedError } from "@opencode-ai/util/error"
import { MessageV2 } from "./message-v2"
import { iife } from "@/util/iife"
import * as Abort from "@/util/abort"

export namespace SessionRetry {
  export const RETRY_INITIAL_DELAY = 2000
  export const RETRY_BACKOFF_FACTOR = 2
  export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
  export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout
  // A server-supplied retry-after is advisory, not to be trusted blindly. A 0 or
  // tiny value would turn the retry loop into a CPU-pegged hot loop; a
  // pathological multi-day value would wedge the session busy indefinitely. Clamp
  // every honored delay into a sane band.
  export const RETRY_MIN_DELAY = 1000 // 1 second floor
  export const RETRY_MAX_HONORED_DELAY = 60_000 // 60 second ceiling
  // Cap total attempts so a provider stuck returning retryable errors can't keep
  // a session busy forever; surface the error instead.
  export const RETRY_MAX_ATTEMPTS = 10

  export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return Abort.sleep(Math.min(ms, RETRY_MAX_DELAY), signal)
  }

  function clamp(ms: number) {
    return Math.min(Math.max(ms, RETRY_MIN_DELAY), RETRY_MAX_HONORED_DELAY)
  }

  export function delay(attempt: number, error?: MessageV2.APIError) {
    if (error) {
      const headers = error.data.responseHeaders
      if (headers) {
        const retryAfterMs = headers["retry-after-ms"]
        if (retryAfterMs) {
          const parsedMs = Number.parseFloat(retryAfterMs)
          if (!Number.isNaN(parsedMs)) {
            return clamp(parsedMs)
          }
        }

        const retryAfter = headers["retry-after"]
        if (retryAfter) {
          const parsedSeconds = Number.parseFloat(retryAfter)
          if (!Number.isNaN(parsedSeconds)) {
            // convert seconds to milliseconds
            return clamp(Math.ceil(parsedSeconds * 1000))
          }
          // Try parsing as HTTP date format
          const parsed = Date.parse(retryAfter) - Date.now()
          if (!Number.isNaN(parsed) && parsed > 0) {
            return clamp(Math.ceil(parsed))
          }
        }

        return RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1)
      }
    }

    return Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_DELAY_NO_HEADERS)
  }

  export function retryable(error: ReturnType<NamedError["toObject"]>) {
    if (MessageV2.APIError.isInstance(error)) {
      // A server error (>= 500) is transient and retryable, whatever the
      // provider's isRetryable flag or the body's error `type` says. Anthropic's
      // mid-stream error path stamps a fault as statusCode 500 with
      // isRetryable:false even when the body reads {"type":"rate_limit_error"}:
      // a server fault mislabeled, not a real rate limit (a real one is HTTP 429
      // with retry-after and rate-limit headers, so statusCode < 500).
      const status = error.data.statusCode
      const serverError = status !== undefined && status >= 500
      if (!serverError && !error.data.isRetryable) return undefined
      return error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message
    }

    const json = iife(() => {
      try {
        if (typeof error.data?.message === "string") {
          const parsed = JSON.parse(error.data.message)
          return parsed
        }

        return JSON.parse(error.data.message)
      } catch {
        return undefined
      }
    })
    try {
      if (!json || typeof json !== "object") return undefined
      const code = typeof json.code === "string" ? json.code : ""

      if (json.type === "error" && json.error?.type === "too_many_requests") {
        return "Too Many Requests"
      }
      if (code.includes("exhausted") || code.includes("unavailable")) {
        return "Provider is overloaded"
      }
      if (json.type === "error" && json.error?.code?.includes("rate_limit")) {
        return "Rate Limited"
      }
      return JSON.stringify(json)
    } catch {
      return undefined
    }
  }
}
