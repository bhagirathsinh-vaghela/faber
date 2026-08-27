import path from "path"
import { Auth } from "../auth"
import { Global } from "../global"
import { Log } from "../util/log"
import type { Engine, Host } from "./engine"

const log = Log.create({ service: "dictation.deepgram" })

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

export function deepgram(host: Host): Engine {
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
    host.fail(message)
    teardown()
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
      host.transcript({ text, final: message.is_final === true })
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
      host.done()
    }
  })()

  return {
    frame(data) {
      lastAudio = Date.now()
      if (upstream?.readyState === WebSocket.OPEN) {
        upstream.send(data)
        return
      }
      pending.push(data)
    },
    stop() {
      stopping = true
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ type: "CloseStream" }))
      // Deepgram flushes tail finals then closes; the safety timer covers a
      // wedged upstream so the browser socket never hangs open.
      setTimeout(() => {
        if (closed) return
        teardown()
        host.done()
      }, STOP_DRAIN_MS)
    },
    close() {
      teardown()
    },
  }
}
