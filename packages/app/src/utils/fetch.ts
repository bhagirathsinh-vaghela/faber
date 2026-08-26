// Every request the app makes gets a deadline, because a promise that never
// settles is worse than one that rejects.
//
// When iOS suspends a backgrounded tab it kills the underlying sockets without
// telling the page, so a fetch in flight at that moment neither resolves nor
// rejects on resume. Every in-flight-promise guard it sits behind stays latched
// for the life of the document, and `retry` only retries REJECTIONS, so a hang
// is never retried either.
//
// Two deadlines, because a request dies in two places: nothing comes back at
// all (the suspend-kill case), or headers arrive and the body stops mid-
// download. The body clock is petted per chunk, so a slow but progressing
// transfer is never cut off — only true silence trips it.
//
// Long-lived streams are exempt: an SSE connection is meant to sit idle between
// events and carries its own liveness watchdog keyed to the server's heartbeat.

// Generous on purpose. These exist to convert a request that will NEVER answer
// into one that rejects, not to enforce a latency budget: a slow answer is a
// success, and cutting one off on a bad cellular link turns a working app into
// a broken one. Cellular routinely blows several seconds on radio wake-up
// alone before a byte moves, so the bar is "no reasonable link would still be
// silent by now" rather than "this is taking too long".
export const HEADERS_MS = 60_000
export const STALL_MS = 60_000

// Either signal is sufficient, so adding a stream endpoint without the header
// (or a header without the path suffix) cannot silently arm a deadline on it.
export function streaming(request: Request) {
  if (request.headers.get("accept")?.includes("text/event-stream")) return true
  try {
    return new URL(request.url).pathname.endsWith("/event")
  } catch {
    return false
  }
}

// AbortSignal.any would express this in one line but is too new to rely on
// across the WebKit versions this app runs in.
function link(controller: AbortController, signal: AbortSignal | null | undefined) {
  if (!signal) return () => {}
  if (signal.aborted) {
    controller.abort(signal.reason)
    return () => {}
  }
  const forward = () => controller.abort(signal.reason)
  // `once` bounds the listener even when the caller abandons the body without
  // cancelling it, which is the path where the explicit removal below is never
  // reached — a long-lived signal shared across many requests would otherwise
  // accumulate one listener per request.
  signal.addEventListener("abort", forward, { once: true })
  return () => signal.removeEventListener("abort", forward)
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export function guard(base: Fetch, options: { headers?: number; stall?: number } = {}): typeof fetch {
  const headersMs = options.headers ?? HEADERS_MS
  const stallMs = options.stall ?? STALL_MS

  const guarded = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request && !init ? input : new Request(input as RequestInfo, init)
    if (streaming(request)) return base(input as RequestInfo, init)

    const controller = new AbortController()
    const unlink = link(controller, request.signal)

    let timer: ReturnType<typeof setTimeout> | undefined
    const clear = () => {
      if (timer) clearTimeout(timer)
      timer = undefined
      unlink()
    }
    // Raced, not merely aborted. Abort is a request to stop that the engine is
    // free to ignore, and the wedged-socket case is exactly where it does; the
    // race is what makes settlement unconditional. Covers the caller's own
    // abort too, so a cancelled request never waits out the deadline.
    const stopped = new Promise<never>((_, reject) => {
      timer = setTimeout(() => controller.abort(new Error("request timed out")), headersMs)
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason))
    })

    const response = await Promise.race([base(new Request(request, { signal: controller.signal })), stopped]).catch(
      (error) => {
        clear()
        throw error
      },
    )

    // Headers arrived, so the deadline they were racing has been met. Leaving
    // it armed would fire an abort into a request that is already succeeding.
    if (timer) clearTimeout(timer)
    timer = undefined

    // A bodyless status has nothing left to stall on, and re-wrapping one
    // throws.
    if (!response.body || response.status === 204 || response.status === 304) {
      clear()
      return response
    }

    // Engines without the stream transforms still get the headers deadline,
    // which covers the case that actually hangs.
    if (typeof TransformStream === "undefined") {
      clear()
      return response
    }

    // Pumping by hand rather than pipeThrough, so a stall can error the stream
    // the caller is reading. Aborting the request alone is not enough: the
    // engine may leave the body reader parked, which is the same silent hang
    // one layer down.
    const source = response.body.getReader()
    const body = new ReadableStream<Uint8Array>({
      async pull(target) {
        const stalled = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error("response stalled")
            controller.abort(error)
            reject(error)
          }, stallMs)
        })
        const read = await Promise.race([source.read(), stalled]).catch((error) => {
          clear()
          target.error(error)
          void source.cancel(error).catch(() => {})
          return undefined
        })
        if (!read) return
        if (timer) clearTimeout(timer)
        if (read.done) {
          clear()
          target.close()
          return
        }
        target.enqueue(read.value)
      },
      cancel(reason) {
        clear()
        return source.cancel(reason)
      },
    })

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }

  return Object.assign(guarded, { preconnect: globalThis.fetch?.preconnect }) as typeof fetch
}
