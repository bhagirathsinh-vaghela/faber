import path from "path"
import type { WSContext } from "hono/ws"
import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { Auth } from "../auth"
import { Global } from "../global"
import { Log } from "../util/log"

export namespace Dictation {
  const log = Log.create({ service: "dictation" })

  // A device without a mic (or without a secure origin) can't dictate. The pool
  // is a global, in-memory drop for transcripts captured on a companion device:
  // the companion appends here, any composer on any other device pulls an entry
  // into its input and removes it. In-memory only — a restart clears it.
  export namespace Pool {
    export const Entry = z
      .object({
        id: z.string(),
        text: z.string(),
        timestamp: z.number(),
      })
      .meta({ ref: "DictationPoolEntry" })
    export type Entry = z.infer<typeof Entry>

    export const Event = {
      Updated: BusEvent.define("dictation.pool.updated", z.object({ entries: Entry.array() })),
    }

    let entries: Entry[] = []

    function emit() {
      GlobalBus.emit("event", {
        directory: "global",
        payload: { type: Event.Updated.type, properties: { entries } },
      })
    }

    export function list() {
      return entries
    }

    export function append(text: string) {
      entries.push({ id: crypto.randomUUID(), text, timestamp: Date.now() })
      emit()
    }

    export function remove(id: string) {
      entries = entries.filter((entry) => entry.id !== id)
      emit()
    }
  }

  const PARAMS = {
    model: "nova-3",
    interim_results: "true",
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    smart_format: "true",
    punctuate: "true",
    language: "en-US",
    mip_opt_out: "true",
  }
  // Deepgram caps keyterm prompting at ~500 tokens total; staying at 400
  // (estimated at len/4 per term) degrades gracefully instead of failing the
  // upgrade with HTTP 400.
  const KEYTERM_TOKEN_BUDGET = 400
  const KEEPALIVE_MS = 5_000
  const STOP_DRAIN_MS = 3_000

  async function key() {
    const auth = await Auth.get("deepgram")
    if (auth?.type === "api") return auth.key
    return process.env["DEEPGRAM_API_KEY"]
  }

  async function keyterms() {
    const text = await Bun.file(path.join(Global.Path.config, "dictation-vocabulary.txt"))
      .text()
      .catch(() => "")
    const terms: string[] = []
    let tokens = 0
    for (const line of text.split("\n")) {
      const term = line.trim()
      if (!term || term.startsWith("#")) continue
      const cost = Math.ceil(term.length / 4)
      if (tokens + cost > KEYTERM_TOKEN_BUDGET) {
        log.warn("vocabulary exceeds keyterm token budget, truncating", { kept: terms.length })
        break
      }
      tokens += cost
      terms.push(term)
    }
    return terms
  }

  export function connect(client: WSContext) {
    let upstream: WebSocket | undefined
    let closed = false
    let stopping = false
    const pending: ArrayBuffer[] = []
    let lastAudio = Date.now()

    const keepalive = setInterval(() => {
      if (upstream?.readyState !== WebSocket.OPEN) return
      if (Date.now() - lastAudio < KEEPALIVE_MS) return
      upstream.send(JSON.stringify({ type: "KeepAlive" }))
    }, KEEPALIVE_MS)

    const teardown = () => {
      closed = true
      clearInterval(keepalive)
      if (upstream && upstream.readyState <= WebSocket.OPEN) upstream.close()
    }

    const fail = (message: string) => {
      log.error("dictation failed", { message })
      client.send(JSON.stringify({ type: "error", message }))
      teardown()
      client.close()
    }

    ;(async () => {
      const apiKey = await key()
      if (!apiKey) {
        fail("Deepgram API key not configured — set it via PUT /auth/deepgram or the DEEPGRAM_API_KEY env var")
        return
      }
      const url = new URL("wss://api.deepgram.com/v1/listen")
      for (const [param, value] of Object.entries(PARAMS)) url.searchParams.set(param, value)
      const terms = await keyterms()
      for (const term of terms) url.searchParams.append("keyterm", term)
      if (closed) return
      log.info("connecting to deepgram", { keyterms: terms.length })
      // Deepgram accepts the key via the websocket subprotocol ("token", <key>);
      // avoids Bun's non-standard headers option, which the DOM lib types reject.
      const socket = new WebSocket(url.toString(), ["token", apiKey])
      socket.binaryType = "arraybuffer"
      upstream = socket
      socket.onopen = () => {
        log.info("deepgram connected")
        for (const frame of pending) socket.send(frame)
        pending.length = 0
        if (stopping) socket.send(JSON.stringify({ type: "CloseStream" }))
      }
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return
        const message = JSON.parse(event.data)
        if (message.type !== "Results") return
        const text = message.channel?.alternatives?.[0]?.transcript?.trim()
        if (!text) return
        client.send(JSON.stringify({ type: "transcript", text, final: message.is_final === true }))
      }
      socket.onerror = () => {
        if (closed) return
        fail("Deepgram connection error — check the API key and account status")
      }
      socket.onclose = (event) => {
        if (closed) return
        if (!stopping && event.code !== 1000) {
          fail(`Deepgram closed the connection (code ${event.code}${event.reason ? `: ${event.reason}` : ""})`)
          return
        }
        teardown()
        client.close()
      }
    })()

    return {
      onMessage(data: string | ArrayBuffer) {
        if (typeof data === "string") {
          if (JSON.parse(data).type !== "stop") return
          stopping = true
          if (upstream?.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ type: "CloseStream" }))
          // Deepgram flushes tail finals then closes; the safety timer covers a
          // wedged upstream so the browser socket never hangs open.
          setTimeout(() => {
            if (closed) return
            teardown()
            client.close()
          }, STOP_DRAIN_MS)
          return
        }
        lastAudio = Date.now()
        if (upstream?.readyState === WebSocket.OPEN) {
          upstream.send(data)
          return
        }
        pending.push(data)
      },
      onClose() {
        log.info("client disconnected")
        teardown()
      },
    }
  }
}
