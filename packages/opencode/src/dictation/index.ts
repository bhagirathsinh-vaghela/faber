import type { WSContext } from "hono/ws"
import { Config } from "../config/config"
import { Log } from "../util/log"
import { deepgram } from "./deepgram"
import { local } from "./local"
import { DictationRate } from "./rate"
import type { Engine, Host } from "./engine"

export namespace Dictation {
  const log = Log.create({ service: "dictation" })

  const DEFAULT_LOCAL_URL = "http://127.0.0.1:4100"

  export function connect(client: WSContext) {
    let engine: Engine | undefined
    let closed = false
    // Selecting the engine is async, and the browser starts sending as soon as
    // the socket opens, so early frames wait here rather than being dropped. A
    // commit or stop arriving in that window is replayed after the frames.
    const buffered: (ArrayBuffer | "commit")[] = []
    let pendingStop: number | undefined

    const host: Host = {
      transcript(value) {
        if (closed) return
        client.send(JSON.stringify({ type: "transcript", text: value.text, final: value.final }))
      },
      fail(message) {
        if (closed) return
        log.error("dictation failed", { message })
        client.send(JSON.stringify({ type: "error", message }))
        closed = true
        engine?.close()
        client.close()
      },
      done() {
        if (closed) return
        closed = true
        engine?.close()
        client.close()
      },
    }

    // The websocket upgrade carries no instance context, so this reads the
    // global config rather than Config.get().
    Config.getGlobal()
      .then(async (config) => {
        const chosen = config.dictation?.engine ?? "deepgram"
        log.info("starting engine", { engine: chosen })
        const url = config.dictation?.url ?? DEFAULT_LOCAL_URL
        // The browser is told the rate to sample at rather than assuming one, so
        // a model whose rate differs from the default is fed correctly.
        const rate = chosen === "local" ? await DictationRate.get(url) : DictationRate.DEFAULT
        if (closed) return
        client.send(JSON.stringify({ type: "rate", rate }))
        engine = chosen === "local" ? local(host, url) : deepgram(host)
        if (closed) engine.close()
        for (const frame of buffered) frame === "commit" ? engine.commit() : engine.frame(frame)
        buffered.length = 0
        if (pendingStop !== undefined) engine.stop(pendingStop)
      })
      .catch((error) => {
        log.error("engine failed to start", { error })
        host.fail("Dictation engine failed to start")
      })

    return {
      onMessage(data: string | ArrayBuffer) {
        if (typeof data === "string") {
          const message = JSON.parse(data)
          if (message.type === "commit") {
            if (!engine) {
              buffered.push("commit")
              return
            }
            engine.commit()
            return
          }
          if (message.type !== "stop") return
          if (!engine) {
            pendingStop = message.rate
            return
          }
          engine.stop(message.rate)
          return
        }
        if (!engine) {
          buffered.push(data)
          return
        }
        engine.frame(data)
      },
      onClose() {
        log.info("client disconnected")
        closed = true
        engine?.close()
      },
    }
  }
}
