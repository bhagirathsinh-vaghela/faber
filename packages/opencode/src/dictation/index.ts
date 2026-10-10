import type { WSContext } from "hono/ws"
import { Config } from "../config/config"
import { Log } from "../util/log"
import { local } from "./local"
import { DictationRate } from "./rate"
import { DictationRecover } from "./recover"
import type { Engine, Host } from "./engine"

export namespace Dictation {
  const log = Log.create({ service: "dictation" })

  // The local speech sidecar's default address; it serves /transcribe and /speak.
  export const DEFAULT_URL = "http://127.0.0.1:4111"

  export function connect(client: WSContext, id?: string) {
    let engine: Engine | undefined
    let closed = false
    // Set once a real "stop" arrives, so an unexpected socket close can be told
    // apart from the client saying it is done.
    let stopped = false
    // Every final transcript accumulates here so a socket that drops mid-session
    // can hand the finished text to recovery instead of losing it.
    let transcript = ""
    // While recovering, the client is gone: transcripts route to the store and
    // done/fail must not touch the dead socket.
    let recovering = false
    // The rate the client was told to capture at. A recovery stops the engine on
    // the client's behalf, so it must claim the rate the audio was sampled at.
    let rate = DictationRate.DEFAULT
    // Selecting the engine is async, and the browser starts sending as soon as
    // the socket opens, so early frames wait here rather than being dropped. A
    // commit or stop arriving in that window is replayed after the frames.
    const buffered: (ArrayBuffer | "commit")[] = []
    let pendingStop: number | undefined

    const host: Host = {
      transcript(value) {
        if (value.final && value.text) transcript = transcript ? `${transcript} ${value.text}` : value.text
        if (closed || recovering) return
        client.send(JSON.stringify({ type: "transcript", text: value.text, final: value.final }))
      },
      fail(message) {
        if (closed || recovering) return
        log.error("dictation failed", { message })
        client.send(JSON.stringify({ type: "error", message }))
        closed = true
        engine?.close()
        client.close()
      },
      done() {
        if (closed || recovering) return
        closed = true
        engine?.close()
        client.close()
      },
    }

    // The websocket upgrade carries no instance context, so this reads the
    // global config rather than Config.get().
    Config.getGlobal()
      .then(async (config) => {
        const url = config.dictation?.url ?? DEFAULT_URL
        // The browser is told the rate to sample at rather than assuming one, so
        // a model whose rate differs from the default is fed correctly.
        rate = await DictationRate.get(url)
        if (closed) return
        client.send(JSON.stringify({ type: "rate", rate }))
        const started = local(host, url)
        engine = started
        for (const frame of buffered) frame === "commit" ? started.commit() : started.frame(frame)
        buffered.length = 0
        if (pendingStop !== undefined) started.stop(pendingStop)
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
          stopped = true
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
        // A clean stop already ran the transcript back to the client, so its
        // close needs nothing more. An unexpected close with an id still owes
        // the user a transcript: finish the buffered audio and hold the text
        // under the id for the client to pull when it reconnects.
        if (stopped || !engine || !id) {
          log.info("client disconnected")
          closed = true
          engine?.close()
          return
        }
        log.info("client dropped, recovering transcript", { id })
        recovering = true
        DictationRecover.track(
          id,
          Promise.resolve(engine.stop(rate)).finally(() => {
            if (transcript) DictationRecover.put(id, transcript)
            closed = true
            engine?.close()
          }),
        )
      },
    }
  }
}
