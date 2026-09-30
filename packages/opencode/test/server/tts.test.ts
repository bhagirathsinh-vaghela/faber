import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { VoicePreference } from "../../src/preference/voice"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"

Log.init({ print: false })

type Call = { path: string; session: string | null; body: string }

const state = {
  sidecar: null as ReturnType<typeof Bun.serve> | null,
  calls: [] as Call[],
  answer: (_req: Request): Response | Promise<Response> =>
    new Response("RIFFaudio", { headers: { "content-type": "audio/wav", "x-audio-seconds": "1.5" } }),
}

const GLOBAL = path.join(Global.Path.config, "opencode.json")
const ANSWER = state.answer

beforeAll(() => {
  state.sidecar = Bun.serve({
    port: 0,
    async fetch(req) {
      state.calls.push({
        path: new URL(req.url).pathname,
        session: req.headers.get("x-speech-session"),
        body: await req.text(),
      })
      return state.answer(req)
    },
  })
})

// Reset before each test too: another file in the same run may leave a voice
// stored, and the config-voice assertions below depend on there being none.
beforeEach(async () => {
  await VoicePreference.set({ name: null })
  state.calls.length = 0
  state.answer = ANSWER
  await Bun.write(GLOBAL, JSON.stringify({ dictation: { url: state.sidecar!.url.origin, voice: "af_config" } }))
  Config.global.reset()
})

afterEach(async () => {
  await VoicePreference.set({ name: null })
  await fs.rm(GLOBAL, { force: true })
  Config.global.reset()
})

afterAll(() => {
  state.sidecar?.stop(true)
})

const post = (route: string, body?: unknown) =>
  Server.App().request(route, {
    method: "POST",
    headers: { "content-type": "application/json", "x-speech-session": "tab-1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

describe("POST /tts/speak", () => {
  test("forwards text, the config voice, and a known priority with the speech session", async () => {
    const response = await post("/tts/speak", { text: "Hello there.", priority: "next", voice: "ignored" })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("audio/wav")
    expect(response.headers.get("x-audio-seconds")).toBe("1.5")
    expect(await response.text()).toBe("RIFFaudio")
    expect(state.calls).toEqual([
      {
        path: "/speak",
        session: "tab-1",
        body: JSON.stringify({ text: "Hello there.", voice: "af_config", priority: "next" }),
      },
    ])
  })

  test("a picked voice wins over the config one, and an unknown priority is dropped", async () => {
    await VoicePreference.set({ name: "af_picked" })
    await post("/tts/speak", { text: "Hi.", priority: "urgent" })
    expect(state.calls.map((call) => JSON.parse(call.body))).toEqual([{ text: "Hi.", voice: "af_picked" }])
  })

  test("a stored empty voice speaks the config voice", async () => {
    await VoicePreference.set({ name: "" })
    await post("/tts/speak", { text: "Hi." })
    expect(state.calls.map((call) => JSON.parse(call.body))).toEqual([{ text: "Hi.", voice: "af_config" }])
  })

  test("a request the client abandons aborts the sidecar request it waits on", async () => {
    const reached = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<string>()
    state.answer = (req) => {
      req.signal.addEventListener("abort", () => aborted.resolve("aborted"), { once: true })
      reached.resolve()
      return new Promise<Response>(() => {})
    }
    const client = new AbortController()
    const pending = Promise.resolve(
      Server.App().request("/tts/speak", {
        method: "POST",
        headers: { "content-type": "application/json", "x-speech-session": "tab-1" },
        body: JSON.stringify({ text: "Hi." }),
        signal: client.signal,
      }),
    ).catch(() => undefined)
    await reached.promise
    client.abort()
    expect(await Promise.race([aborted.promise, Bun.sleep(2_000).then(() => "still waiting")])).toBe("aborted")
    await pending
  })

  test("a sidecar 4xx keeps its status and a 5xx becomes 502, both without the sidecar URL", async () => {
    state.answer = () => new Response("empty text", { status: 400 })
    const rejected = await post("/tts/speak", { text: "Hi." })
    expect(rejected.status).toBe(400)
    expect(await rejected.text()).toBe("speech engine answered 400: empty text")

    state.answer = () => new Response("speak cancelled: client disconnected", { status: 503 })
    const cancelled = await post("/tts/speak", { text: "Hi." })
    expect(cancelled.status).toBe(502)
    expect(await cancelled.text()).toBe("speech engine answered 503: speak cancelled: client disconnected")

    state.answer = () => new Response("x".repeat(400), { status: 500 })
    const failed = await post("/tts/speak", { text: "Hi." })
    expect(failed.status).toBe(502)
    expect(await failed.text()).toBe(`speech engine answered 500: ${"x".repeat(300)}`)

    state.answer = () => new Response("busy", { status: 503 })
    const busy = await post("/tts/speak", { text: "Hi." })
    expect(busy.status).toBe(502)
    expect(await busy.text()).toBe("speech engine answered 503: busy")
  })

  test("an unreachable sidecar is a 503 naming the reason, not the URL", async () => {
    const closed = Bun.serve({ port: 0, fetch: () => new Response() })
    const url = closed.url.origin
    closed.stop(true)
    await Bun.write(GLOBAL, JSON.stringify({ dictation: { url } }))
    Config.global.reset()
    const reason = await fetch(`${url}/speak`, { method: "POST" }).then(
      () => "reachable",
      (error: Error) => error.message,
    )
    expect(reason).not.toBe("reachable")
    const response = await post("/tts/speak", { text: "Hi." })
    expect(response.status).toBe(503)
    expect(await response.text()).toBe(`speech engine unreachable: ${reason}`)
  })

  test("text that is missing, blank, or not a string is a 400 and never reaches the sidecar", async () => {
    for (const body of [{}, { text: "   " }, { text: 42 }, { text: ["a"] }]) {
      const response = await post("/tts/speak", body)
      expect(response.status).toBe(400)
      expect(await response.text()).toBe("text must be a non-empty string")
    }
    expect(state.calls).toEqual([])
  })
})

describe("POST /tts/done", () => {
  test("releases the speech session at the sidecar", async () => {
    const response = await post("/tts/done")
    expect(await response.json()).toEqual({ released: true })
    expect(state.calls).toEqual([{ path: "/done", session: "tab-1", body: "" }])
  })

  test("still answers released when the sidecar fails", async () => {
    state.answer = () => new Response("gone", { status: 500 })
    const response = await post("/tts/done")
    expect(await response.json()).toEqual({ released: true })
    expect(state.calls).toEqual([{ path: "/done", session: "tab-1", body: "" }])
  })
})
