import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { TtsRewrite } from "../../src/session/tts-rewrite"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

type Body = {
  model: string
  system: unknown[]
  messages: { role: string; content: { type: string; text: string }[] }[]
  thinking?: unknown
}

type Capture = { body: Body; aborted: Promise<"aborted"> }

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  queue: [] as Array<{ response: () => Response; resolve: (value: Capture) => void }>,
  requests: 0,
}

function respond(response: () => Response) {
  return new Promise<Capture>((resolve) => state.queue.push({ response, resolve }))
}

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      state.requests++
      const next = state.queue.shift()
      if (!next) return new Response("unexpected request", { status: 500 })
      const aborted = new Promise<"aborted">((resolve) =>
        req.signal.addEventListener("abort", () => resolve("aborted"), { once: true }),
      )
      next.resolve({ body: (await req.json()) as Body, aborted })
      return next.response()
    },
  })
})

const TIMING = { ...TtsRewrite.timing }
const GLOBAL = path.join(Global.Path.config, "opencode.json")

beforeEach(() => {
  state.queue.length = 0
  state.requests = 0
})

afterEach(async () => {
  Object.assign(globalThis, REAL)
  Object.assign(TtsRewrite.timing, TIMING)
  await fs.rm(GLOBAL, { force: true })
  Config.global.reset()
})

afterAll(() => {
  state.server?.stop(true)
})

const MODEL = "claude-3-5-sonnet-20241022"
const NAME = `anthropic/${MODEL}`
const HEADERS = { "Content-Type": "text/event-stream" }
const encoder = new TextEncoder()
const frames = (chunks: unknown[]) =>
  encoder.encode(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""))
const opening = [
  {
    type: "message_start",
    message: {
      id: "msg-1",
      model: MODEL,
      usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
]
const delta = (text: string) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })
const closing = (reason: string) => [
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 4 } },
  { type: "message_stop" },
]

function reply(texts: string[], reason = "end_turn") {
  return new Response(frames([...opening, ...texts.map(delta), ...closing(reason)]), { status: 200, headers: HEADERS })
}

// A reply that sends its opening (and text, when given) and then never finishes.
function hanging(text?: string) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(frames([...opening, ...(text === undefined ? [] : [delta(text)])]))
    },
  })
  return new Response(stream, { status: 200, headers: HEADERS })
}

// A reply that sends its first text, then waits for release to send the rest.
function gated(first: string) {
  const gate = Promise.withResolvers<string>()
  const response = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(frames([...opening, delta(first)]))
          const rest = await gate.promise
          controller.enqueue(frames([delta(rest), ...closing("end_turn")]))
          controller.close()
        },
      }),
      { status: 200, headers: HEADERS },
    )
  return { response, release: gate.resolve }
}

// A reply that sends its opening and first text, then the body ends mid-message.
function dropped(first: string) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frames([...opening, delta(first)]))
        setTimeout(() => controller.close(), 20)
      },
    }),
    { status: 200, headers: HEADERS },
  )
}

// Observes the one interval the route arms at the heartbeat delay: how often it
// fired, and whether it was cleared. Every other interval passes through.
const REAL = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval }

function watchHeartbeat(ms: number) {
  const watch = { handle: undefined as ReturnType<typeof setInterval> | undefined, fires: 0, cleared: false }
  globalThis.setInterval = ((fn: () => void, delay?: number) => {
    if (delay !== ms) return REAL.setInterval(fn, delay)
    watch.handle = REAL.setInterval(() => {
      watch.fires++
      fn()
    }, delay)
    return watch.handle
  }) as typeof setInterval
  globalThis.clearInterval = ((handle?: ReturnType<typeof setInterval>) => {
    if (handle !== undefined && handle === watch.handle) watch.cleared = true
    REAL.clearInterval(handle)
  }) as typeof clearInterval
  return watch
}

const variantful = {
  [MODEL]: {
    name: "Claude",
    family: "claude",
    release_date: "2024-10-22",
    attachment: false,
    reasoning: true,
    temperature: true,
    tool_call: true,
    cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
    limit: { context: 200000, output: 8192 },
    modalities: { input: ["text"], output: ["text"] },
  },
}

async function withInstance(fn: () => Promise<void>, models: Record<string, object> = {}) {
  await using project = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          enabled_providers: ["anthropic"],
          model: NAME,
          instructions: [],
          provider: {
            anthropic: { options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` }, models },
          },
        }),
      )
    },
  })
  await Instance.provide({ directory: project.path, fn })
}

function prepare(text: string, signal = new AbortController().signal) {
  const lines: TtsRewrite.Line[] = []
  const heard = Promise.withResolvers<TtsRewrite.Line>()
  const finished = new Promise<TtsRewrite.Line[]>((resolve) =>
    TtsRewrite.prepare({ text, sessionID: "ses_test" }, signal, (line) => {
      lines.push(line)
      heard.resolve(line)
      if (line.type !== "chunk") resolve(lines)
    }),
  )
  return { lines, finished, heard: heard.promise }
}

const wrapped = (text: string) => `<<<MESSAGE>>>\n${text}\n<<<END>>>`
const promptOf = (capture: Capture) => capture.body.messages[0].content[0].text
const failed = (why: string): TtsRewrite.Line => ({
  type: "error",
  message: `read-aloud rewrite on ${NAME} (variant none) failed: ${why}`,
})
const retried = (first: string, second: string, on = `${NAME} (variant none)`) =>
  failed(`${first}; retry on ${on}: ${second}`)

const FALLBACK = "claude-3-7-sonnet-20250219"

async function rewriteWith(fallback: { model: string; variant?: string }) {
  await Bun.write(GLOBAL, JSON.stringify({ dictation: { rewrite: { model: NAME, fallback } } }))
  Config.global.reset()
}

describe("TtsRewrite.prepare", () => {
  test("streams confirmed chunks, then done, with the prompt as the only cached block", async () => {
    await withInstance(async () => {
      const request = respond(() => reply(["Short start.\nThe rollout ", "is done.\n\nNext, check the error rate.\n"]))
      const lines = await prepare("## Deploy\nThe rollout is **done**.").finished
      const body = (await request).body

      expect(lines).toEqual([
        { type: "chunk", index: 0, text: "Short start." },
        { type: "chunk", index: 1, text: "The rollout is done." },
        { type: "chunk", index: 2, text: "Next, check the error rate." },
        { type: "done", total: 3 },
      ])
      expect(body.system.at(-1)).toEqual({
        type: "text",
        text: TtsRewrite.PROMPT,
        cache_control: { type: "ephemeral", ttl: "1h" },
      })
      // Only the prompt block, and it carries the marker.
      expect(body.system.length).toBe(1)
      expect(body.system.slice(0, -1).filter((block) => (block as { cache_control?: unknown }).cache_control)).toEqual(
        [],
      )
      expect(body.messages).toEqual([
        { role: "user", content: [{ type: "text", text: wrapped("## Deploy\nThe rollout is **done**.") }] },
      ])
    })
  }, 30_000)

  test("a finished rewrite is replayed from memory without a model call", async () => {
    await withInstance(async () => {
      respond(() => reply(["Only once.\n"]))
      const first = await prepare("cache me").finished
      const second = await prepare("cache me").finished
      expect(second).toEqual([
        { type: "chunk", index: 0, text: "Only once." },
        { type: "done", total: 1 },
      ])
      expect(second).toEqual(first)
      expect(state.requests).toBe(1)
    })
  }, 30_000)

  test("concurrent requests for one rewrite share a single model call", async () => {
    await withInstance(async () => {
      respond(() => reply(["Shared line.\n", "Second line here.\n"]))
      const [a, b] = await Promise.all([prepare("shared").finished, prepare("shared").finished])
      expect(a).toEqual([
        { type: "chunk", index: 0, text: "Shared line." },
        { type: "chunk", index: 1, text: "Second line here." },
        { type: "done", total: 2 },
      ])
      expect(b).toEqual(a)
      expect(state.requests).toBe(1)
    })
  }, 30_000)

  test("a late joiner is replayed from chunk 0 and then follows the shared call", async () => {
    await withInstance(async () => {
      const gate = gated("Opening line.\nMiddle ")
      respond(gate.response)
      const first = prepare("late joiner")
      expect(await first.heard).toEqual({ type: "chunk", index: 0, text: "Opening line." })
      const second = prepare("late joiner")
      expect(await second.heard).toEqual({ type: "chunk", index: 0, text: "Opening line." })
      gate.release("line.\n")
      const expected: TtsRewrite.Line[] = [
        { type: "chunk", index: 0, text: "Opening line." },
        { type: "chunk", index: 1, text: "Middle line." },
        { type: "done", total: 2 },
      ]
      expect(await first.finished).toEqual(expected)
      expect(await second.finished).toEqual(expected)
      expect(state.requests).toBe(1)
    })
  }, 30_000)

  test("a stream cut mid-way is retried once as a continuation that resumes the numbering", async () => {
    await withInstance(async () => {
      respond(() => reply(["First sentence.\nSecond sen"], "max_tokens"))
      const retry = respond(() => reply(["Second sentence.\nThird sentence.\n"]))
      const lines = await prepare("continue me").finished

      expect(lines).toEqual([
        { type: "chunk", index: 0, text: "First sentence." },
        { type: "chunk", index: 1, text: "Second sentence. Third sentence." },
        { type: "done", total: 2 },
      ])
      const prompt = promptOf(await retry)
      expect(prompt).toStartWith(`${wrapped("continue me")}\n`)
      expect(prompt).toContain("<<<SPOKEN>>>\nFirst sentence.\n<<<END>>>")
    })
  }, 30_000)

  test("a first attempt that spoke nothing is retried with the plain prompt", async () => {
    await withInstance(async () => {
      respond(() => reply([], "max_tokens"))
      const retry = respond(() => reply(["Now it works.\n"]))
      const lines = await prepare("plain retry").finished
      expect(lines).toEqual([
        { type: "chunk", index: 0, text: "Now it works." },
        { type: "done", total: 1 },
      ])
      expect(promptOf(await retry)).toBe(wrapped("plain retry"))
    })
  }, 30_000)

  test("a first attempt that finishes normally with nothing spoken is retried with the plain prompt", async () => {
    await withInstance(async () => {
      const first = respond(() => reply([]))
      const retry = respond(() => reply(["Second try speaks.\n"]))
      expect(await prepare("silent success").finished).toEqual([
        { type: "chunk", index: 0, text: "Second try speaks." },
        { type: "done", total: 1 },
      ])
      expect(promptOf(await first)).toBe(wrapped("silent success"))
      expect(promptOf(await retry)).toBe(wrapped("silent success"))
      expect(state.requests).toBe(2)
    })
  }, 30_000)

  test("an upstream body that ends mid-message fails the attempt and gets the one retry", async () => {
    await withInstance(async () => {
      respond(() => dropped("Before the drop.\nHalf "))
      const retry = respond(() => reply(["Half done now.\n"]))
      const lines = await prepare("dropped").finished
      expect(lines).toEqual([
        { type: "chunk", index: 0, text: "Before the drop." },
        { type: "chunk", index: 1, text: "Half done now." },
        { type: "done", total: 2 },
      ])
      expect(promptOf(await retry)).toContain("<<<SPOKEN>>>\nBefore the drop.\n<<<END>>>")
    })
  }, 30_000)

  test("a continuation's first words meet the deadline before its first chunk flushes", async () => {
    await withInstance(async () => {
      TtsRewrite.timing.first = 50
      TtsRewrite.timing.overall = 400
      respond(() => reply(["First sentence.\nSecond sen"], "max_tokens"))
      respond(() => hanging("Second sentence. Third sentence continues"))
      expect(await prepare("continuation deadline").finished).toEqual([
        { type: "chunk", index: 0, text: "First sentence." },
        retried(
          `oneshot: ${NAME}: finished with "length" instead of a normal stop`,
          `oneshot: ${NAME}: no complete rewrite within 0.4s`,
        ),
      ])
    })
  }, 30_000)

  test("a continuation that adds nothing after a partial first attempt is an error, never cached", async () => {
    await withInstance(async () => {
      const run = async () => {
        respond(() => reply(["First sentence.\nSecond sen"], "max_tokens"))
        respond(() => reply([]))
        return prepare("partial then empty").finished
      }
      const expected: TtsRewrite.Line[] = [
        { type: "chunk", index: 0, text: "First sentence." },
        retried(`oneshot: ${NAME}: finished with "length" instead of a normal stop`, "the rewrite was empty"),
      ]
      expect(await run()).toEqual(expected)
      expect(await run()).toEqual(expected)
      expect(state.requests).toBe(4)
    })
  }, 30_000)

  test("an empty rewrite after a failed first attempt reads the text as written, never cached", async () => {
    await withInstance(async () => {
      const run = async () => {
        respond(() => reply([], "max_tokens"))
        respond(() => reply([]))
        return prepare("empty twice").finished
      }
      const expected: TtsRewrite.Line[] = [
        { type: "chunk", index: 0, text: "empty twice." },
        { type: "done", total: 1, written: true },
      ]
      expect(await run()).toEqual(expected)
      expect(await run()).toEqual(expected)
      expect(state.requests).toBe(4)
    })
  }, 30_000)

  test("leftover markup fails both attempts, so the text is read as written, never cached", async () => {
    await withInstance(async () => {
      const run = async () => {
        respond(() => reply(["| a | b |\n"]))
        respond(() => reply(["Done [x] here.\n"]))
        return prepare("markup").finished
      }
      const expected: TtsRewrite.Line[] = [
        { type: "chunk", index: 0, text: "markup." },
        { type: "done", total: 1, written: true },
      ]
      expect(await run()).toEqual(expected)
      expect(await run()).toEqual(expected)
      expect(state.requests).toBe(4)
    })
  }, 30_000)

  test("no spoken text within the first-text deadline fails each attempt", async () => {
    await withInstance(async () => {
      TtsRewrite.timing.first = 50
      respond(() => hanging())
      respond(() => hanging())
      expect(await prepare("silent").finished).toEqual([
        { type: "chunk", index: 0, text: "silent." },
        { type: "done", total: 1, written: true },
      ])
      expect(state.requests).toBe(2)
    })
  }, 30_000)

  test("text that yields no chunk (whitespace, a divider) does not meet the first-text deadline", async () => {
    await withInstance(async () => {
      TtsRewrite.timing.first = 50
      TtsRewrite.timing.overall = 5_000
      respond(() => hanging("\n---\n  "))
      respond(() => hanging("\n---\n  "))
      expect(await prepare("divider only").finished).toEqual([
        { type: "chunk", index: 0, text: "divider only." },
        { type: "done", total: 1, written: true },
      ])
      expect(state.requests).toBe(2)
    })
  }, 30_000)

  test("text with nothing to speak still ends in one error when both attempts fail", async () => {
    await withInstance(async () => {
      respond(() => reply([], "refusal"))
      respond(() => reply([], "refusal"))
      const why = `oneshot: ${NAME}: finished with "content-filter" instead of a normal stop`
      expect(await prepare("---").finished).toEqual([retried(why, why)])
    })
  }, 30_000)

  test("the overall budget covers both attempts, so a spent budget leaves no retry", async () => {
    await withInstance(async () => {
      TtsRewrite.timing.overall = 150
      respond(() => hanging("Heard.\nNever fini"))
      expect(await prepare("budget").finished).toEqual([
        { type: "chunk", index: 0, text: "Heard." },
        retried(`oneshot: ${NAME}: no complete rewrite within 0.15s`, "no complete rewrite within 0.15s"),
      ])
      expect(state.requests).toBe(1)
    })
  }, 30_000)

  test("dictation.rewrite picks the model and variant that reach the wire", async () => {
    await Bun.write(GLOBAL, JSON.stringify({ dictation: { rewrite: { model: NAME, variant: "high" } } }))
    Config.global.reset()
    await withInstance(async () => {
      const request = respond(() => reply(["On the high variant.\n"]))
      expect(await prepare("pick my model").finished).toEqual([
        { type: "chunk", index: 0, text: "On the high variant." },
        { type: "done", total: 1 },
      ])
      const body = (await request).body
      expect(body.model).toBe(MODEL)
      expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 4095 })
    }, variantful)
  }, 30_000)

  test("a refused first attempt is retried on the fallback model and variant", async () => {
    await rewriteWith({ model: `anthropic/${FALLBACK}`, variant: "high" })
    await withInstance(async () => {
      const first = respond(() => reply([], "refusal"))
      const retry = respond(() => reply(["Read on the fallback.\n"]))
      expect(await prepare("refused here").finished).toEqual([
        { type: "chunk", index: 0, text: "Read on the fallback." },
        { type: "done", total: 1 },
      ])
      expect((await first).body.model).toBe(MODEL)
      const body = (await retry).body
      expect(body.model).toBe(FALLBACK)
      expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 16000 })
      expect(promptOf(await retry)).toBe(wrapped("refused here"))
    })
  }, 30_000)

  test("both models failing after some speech is one error naming each", async () => {
    await rewriteWith({ model: `anthropic/${FALLBACK}`, variant: "high" })
    await withInstance(async () => {
      respond(() => reply(["First sentence.\nSecond sen"], "max_tokens"))
      const retry = respond(() => reply([]))
      expect(await prepare("partial on both").finished).toEqual([
        { type: "chunk", index: 0, text: "First sentence." },
        retried(
          `oneshot: ${NAME}: finished with "length" instead of a normal stop`,
          "the rewrite was empty",
          `anthropic/${FALLBACK} (variant high)`,
        ),
      ])
      expect(promptOf(await retry)).toContain("<<<SPOKEN>>>\nFirst sentence.\n<<<END>>>")
    })
  }, 30_000)

  test("the last listener leaving aborts the model call, and the next request starts fresh", async () => {
    await withInstance(async () => {
      const request = respond(() => hanging("Heard.\nNever fini"))
      const leaving = new AbortController()
      const first = prepare("abandon me", leaving.signal)
      expect(await first.heard).toEqual({ type: "chunk", index: 0, text: "Heard." })
      leaving.abort()
      expect(await (await request).aborted).toBe("aborted")
      expect(first.lines).toEqual([{ type: "chunk", index: 0, text: "Heard." }])

      respond(() => reply(["Heard.\nFinished now.\n"]))
      expect(await prepare("abandon me").finished).toEqual([
        { type: "chunk", index: 0, text: "Heard." },
        { type: "chunk", index: 1, text: "Finished now." },
        { type: "done", total: 2 },
      ])
      expect(state.requests).toBe(2)
    })
  }, 30_000)

  test("a request already cancelled gets nothing replayed and starts no call", async () => {
    await withInstance(async () => {
      respond(() => reply(["Cached line.\n"]))
      await prepare("cancelled early").finished
      const gone = new AbortController()
      gone.abort()
      const heard: TtsRewrite.Line[] = []
      await TtsRewrite.prepare({ text: "cancelled early", sessionID: "ses_test" }, gone.signal, (line) =>
        heard.push(line),
      )
      await TtsRewrite.prepare({ text: "never started", sessionID: "ses_test" }, gone.signal, (line) =>
        heard.push(line),
      )
      expect(heard).toEqual([])
      expect(state.requests).toBe(1)
    })
  }, 30_000)

  test("a listener that throws is dropped without ending the shared call for the others", async () => {
    await withInstance(async () => {
      const gate = gated("One line.\nTwo ")
      respond(gate.response)
      const steady = prepare("isolated")
      await steady.heard
      const thrown: TtsRewrite.Line[] = []
      await TtsRewrite.prepare({ text: "isolated", sessionID: "ses_test" }, new AbortController().signal, (line) => {
        thrown.push(line)
        if (line.type === "chunk" && line.index === 0) return
        throw new Error("listener broke")
      })
      gate.release("lines.\n")
      expect(await steady.finished).toEqual([
        { type: "chunk", index: 0, text: "One line." },
        { type: "chunk", index: 1, text: "Two lines." },
        { type: "done", total: 2 },
      ])
      expect(thrown).toEqual([
        { type: "chunk", index: 0, text: "One line." },
        { type: "chunk", index: 1, text: "Two lines." },
      ])
    })
  }, 30_000)
})

describe("POST /tts/prepare", () => {
  const post = (body: unknown) =>
    Server.App().request("/tts/prepare", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-opencode-directory": encodeURIComponent(Instance.directory),
      },
      body: JSON.stringify(body),
    })

  test("streams NDJSON lines and rejects a body without text or sessionID", async () => {
    await withInstance(async () => {
      expect((await post({ text: "hi" })).status).toBe(400)
      expect((await post({ text: " ", sessionID: "ses_test" })).status).toBe(400)
      expect((await post({ text: 7, sessionID: "ses_test" })).status).toBe(400)

      respond(() => reply(["Over the wire.\n"]))
      const response = await post({ text: "over http", sessionID: "ses_test" })
      expect(response.headers.get("content-type")).toBe("application/x-ndjson")
      expect(await response.text()).toBe(
        '{"type":"chunk","index":0,"text":"Over the wire."}\n{"type":"done","total":1}\n',
      )
    })
  }, 30_000)

  test("a request aborted mid-rewrite closes the stream, stops the heartbeat, and aborts the upstream call", async () => {
    await withInstance(async () => {
      TtsRewrite.timing.heartbeat = 23
      const watch = watchHeartbeat(23)
      const upstream = respond(() => hanging("Heard.\nNever fini"))
      const leaving = new AbortController()
      const response = await Server.App().request("/tts/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-opencode-directory": encodeURIComponent(Instance.directory) },
        body: JSON.stringify({ text: "abort over http", sessionID: "ses_test" }),
        signal: leaving.signal,
      })
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      const before = { text: "" }
      while (!before.text.includes("\n{") && !before.text.startsWith("{"))
        before.text += decoder.decode((await reader.read()).value)
      while (!before.text.endsWith("}\n")) before.text += decoder.decode((await reader.read()).value)
      expect(before.text.split("\n").filter(Boolean)).toEqual(['{"type":"chunk","index":0,"text":"Heard."}'])

      leaving.abort()
      const fired = watch.fires
      expect(watch.cleared).toBe(true)
      expect(await (await upstream).aborted).toBe("aborted")
      await Bun.sleep(23 * 6)
      expect(watch.fires).toBe(fired)
      const after = { text: "" }
      while (true) {
        const next = await reader.read()
        if (next.done) break
        after.text += decoder.decode(next.value)
      }
      expect(after.text).toBe("")
    })
  }, 30_000)

  test("the heartbeat stops once the done line is written", async () => {
    await withInstance(async () => {
      TtsRewrite.timing.heartbeat = 23
      const watch = watchHeartbeat(23)
      const gate = gated("")
      respond(gate.response)
      const response = await post({ text: "beat then done", sessionID: "ses_test" })
      const reader = response.body!.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("\n")
      expect(watch.cleared).toBe(false)
      gate.release("All done.\n")
      const rest = { text: "" }
      while (true) {
        const next = await reader.read()
        if (next.done) break
        rest.text += new TextDecoder().decode(next.value)
      }
      expect(rest.text.split("\n").filter(Boolean)).toEqual([
        '{"type":"chunk","index":0,"text":"All done."}',
        '{"type":"done","total":1}',
      ])
      expect(watch.cleared).toBe(true)
      const fired = watch.fires
      await Bun.sleep(23 * 6)
      expect(watch.fires).toBe(fired)
    })
  }, 30_000)

  test("writes a blank heartbeat line while the rewrite is silent", async () => {
    await withInstance(async () => {
      TtsRewrite.timing.heartbeat = 20
      const gate = gated("")
      respond(gate.response)
      const response = await post({ text: "slow and healthy", sessionID: "ses_test" })
      const reader = response.body!.getReader()
      const beat = await reader.read()
      expect(new TextDecoder().decode(beat.value)).toBe("\n")
      gate.release("Finally here.\n")
      const rest = await new Response(
        new ReadableStream({
          async pull(controller) {
            const next = await reader.read()
            if (next.done) return controller.close()
            controller.enqueue(next.value)
          },
        }),
      ).text()
      expect(rest.split("\n").filter(Boolean)).toEqual([
        '{"type":"chunk","index":0,"text":"Finally here."}',
        '{"type":"done","total":1}',
      ])
    })
  }, 30_000)
})
