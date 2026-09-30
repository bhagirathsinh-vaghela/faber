import { Hono } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { Config } from "../../config/config"
import { Dictation } from "@/dictation"
import { Instance } from "../../project/instance"
import { InstanceBootstrap } from "../../project/bootstrap"
import { VoicePreference } from "../../preference/voice"
import { TtsRewrite } from "../../session/tts-rewrite"
import { lazy } from "../../util/lazy"
import { Log } from "../../util/log"
import { Directory } from "../directory"

const log = Log.create({ service: "tts" })

const sidecar = async () => (await Config.getGlobal()).dictation?.url ?? Dictation.DEFAULT_URL

const session = (c: { req: { header(name: string): string | undefined } }) => ({
  "x-speech-session": c.req.header("x-speech-session") ?? "",
})

// The sidecar's render priorities; an unknown value is "now".
const PRIORITIES = new Set(["now", "next", "background"])

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function fields(req: { json(): Promise<unknown> }) {
  const body = await req.json().catch(() => undefined)
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}
}

// Proxies synthesis to the speech sidecar so a client needs one origin and no
// knowledge of where the sidecar listens. The sidecar stays bound to loopback,
// and a phone on cellular reaches it the same way it reaches everything else.
export const TtsRoutes = lazy(() =>
  new Hono()
    .post("/speak", async (c) => {
      const body = await fields(c.req)
      const text = body.text
      if (typeof text !== "string" || !text.trim()) return c.text("text must be a non-empty string", 400)
      const priority = typeof body.priority === "string" && PRIORITIES.has(body.priority) ? body.priority : undefined
      // A voice picked in any client's UI wins over the config default; the
      // sidecar falls back to its own default when both are unset. The browser
      // never sends a voice, so a stale tab cannot pin an old one.
      const voice = (await VoicePreference.get()).name || (await Config.getGlobal()).dictation?.voice
      const url = `${await sidecar()}/speak`
      const response = await fetch(url, {
        method: "POST",
        body: JSON.stringify({ text, voice, priority }),
        headers: { "content-type": "application/json", ...session(c) },
        signal: c.req.raw.signal,
      }).catch((error: unknown) => new Error(describe(error)))
      // The body is shown to the user, so the sidecar URL goes to the log only.
      // A sidecar 4xx rejects the request (invalid JSON, invalid request, empty
      // text) and keeps its status. A sidecar 5xx (503: speak cancelled because
      // the client left or /done ran; 500: synthesis failed) becomes 502.
      if (response instanceof Error) {
        // A client that left aborts this fetch too, which is no outage.
        if (!c.req.raw.signal.aborted) log.warn("speech sidecar unreachable", { url, error: response.message })
        return c.text(`speech engine unreachable: ${response.message}`, 503)
      }
      if (!response.ok) {
        const reason = await response.text().catch((error: unknown) => `unreadable body: ${describe(error)}`)
        log.warn("speech sidecar failed", { url, status: response.status, reason: reason.slice(0, 300) })
        return c.text(
          `speech engine answered ${response.status}: ${reason.slice(0, 300)}`,
          response.status < 500 ? (response.status as ContentfulStatusCode) : 502,
        )
      }
      const seconds = response.headers.get("x-audio-seconds")
      return new Response(response.body, {
        headers: {
          "content-type": response.headers.get("content-type") ?? "audio/wav",
          "cache-control": "no-store",
          ...(seconds ? { "x-audio-seconds": seconds } : {}),
        },
      })
    })
    .post("/prepare", async (c) => {
      const body = await fields(c.req)
      const text = typeof body.text === "string" ? body.text : ""
      const sessionID = typeof body.sessionID === "string" ? body.sessionID : ""
      if (!text.trim() || !sessionID) return c.text("text and sessionID are required", 400)
      // /tts mounts ahead of the server's Instance.provide middleware, and the
      // rewrite's model call is instance-scoped, so the work runs in the context
      // the middleware would have supplied.
      const directory = Directory.from(c.req)
      const stop = new AbortController()
      const encoder = new TextEncoder()
      const state = {
        open: true,
        wrote: false,
        beat: undefined as ReturnType<typeof setInterval> | undefined,
        controller: undefined as ReadableStreamDefaultController<Uint8Array> | undefined,
      }
      // Every exit (a terminal line, the client cancelling the body, the request
      // aborting, a failure to start) comes through here once, so no heartbeat
      // outlives the response and the rewrite loses this listener. close is
      // false only when the stream is already cancelled and must not be closed.
      const end = (close: boolean) => {
        if (!state.open) return
        state.open = false
        clearInterval(state.beat)
        stop.abort()
        if (close) state.controller?.close()
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          state.controller = controller
          const send = (line: TtsRewrite.Line) => {
            if (!state.open) return
            controller.enqueue(encoder.encode(JSON.stringify(line) + "\n"))
            state.wrote = true
            if (line.type !== "chunk") end(true)
          }
          // A blank line after a quiet interval keeps a slow rewrite under every
          // idle limit on the path: the app's stall guard (packages/app
          // utils/fetch.ts STALL_MS, 60s; /tts/prepare is not exempt as a
          // stream), Bun's idleTimeout (90s, server.ts; bun-types 1.3.11
          // serve.d.ts: idleTimeout is seconds of inactivity), and any proxy
          // between. application/x-ndjson (github.com/ndjson/ndjson-spec). The
          // spec lets a parser ignore empty lines without requiring it; our
          // client drops them before parsing (app speak.ts prepare, `take`).
          state.beat = setInterval(() => {
            if (state.open && !state.wrote) controller.enqueue(encoder.encode("\n"))
            state.wrote = false
          }, TtsRewrite.timing.heartbeat)
          // Bun 1.3.11 aborts request.signal when the client disconnects (probed).
          const signal = c.req.raw.signal
          if (signal.aborted) return end(true)
          signal.addEventListener("abort", () => end(true), { once: true })
          return Instance.provide({
            directory,
            init: InstanceBootstrap,
            fn: () => TtsRewrite.prepare({ text, sessionID }, stop.signal, send),
          }).catch((error: unknown) =>
            send({ type: "error", message: `read-aloud rewrite could not start in ${directory}: ${describe(error)}` }),
          )
        },
        cancel() {
          end(false)
        },
      })
      return new Response(stream, {
        headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
      })
    })
    .post("/done", async (c) => {
      const url = `${await sidecar()}/done`
      const response = await fetch(url, { method: "POST", headers: session(c) }).catch(
        (error: unknown) => new Error(describe(error)),
      )
      const failure =
        response instanceof Error ? response.message : response.ok ? undefined : `answered ${response.status}`
      if (failure) log.warn("speech sidecar release failed", { url, failure })
      return c.json({ released: true })
    }),
)
