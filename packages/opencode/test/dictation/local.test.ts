import { afterEach, describe, expect, test } from "bun:test"
import { local } from "../../src/dictation/local"
import type { Transcript } from "../../src/dictation/engine"
import { Log } from "../../src/util/log"

Log.init({ print: false })

// A stub standing in for the local transcription sidecar. Each POST to
// /transcribe returns the next queued reply, and every request body is recorded
// so a test can prove one POST happened per committed chunk — the property that
// keeps each chunk an independent utterance.
function sidecar(replies: string[], sampleRate = 16000, failFirst = 0, raw?: string) {
  const bodies: number[] = []
  let health = 0
  let failures = 0
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/health") {
        health++
        return Response.json({ sampleRate })
      }
      const body = await request.arrayBuffer()
      // The first failFirst attempts return 503 to stand in for a restarting
      // sidecar; the body is only recorded on the attempt that succeeds, so
      // posts() counts delivered chunks, not attempts.
      if (failures < failFirst) {
        failures++
        return Response.json({}, { status: 503 })
      }
      bodies.push(body.byteLength)
      if (raw !== undefined) return new Response(raw)
      const text = replies[bodies.length - 1] ?? ""
      return Response.json({ text, ms: 1 })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    posts: () => bodies,
    health: () => health,
    stop: () => server.stop(true),
  }
}

function frame(bytes: number) {
  return new Uint8Array(bytes).buffer
}

function collector() {
  const transcripts: Transcript[] = []
  let failed: string | undefined
  let done = false
  return {
    host: {
      transcript: (value: Transcript) => transcripts.push(value),
      fail: (message: string) => (failed = message),
      done: () => (done = true),
    },
    transcripts: () => transcripts,
    failed: () => failed,
    done: () => done,
  }
}

describe("dictation.local", () => {
  let stub: ReturnType<typeof sidecar>

  afterEach(() => stub?.stop())

  test("stop with no commits sends one POST and finalizes the whole utterance", async () => {
    stub = sidecar(["hello world"])
    const sink = collector()
    const engine = local(sink.host, stub.url)

    engine.frame(frame(10))
    engine.frame(frame(10))
    await engine.stop(16000)

    expect(stub.posts()).toEqual([20])
    expect(sink.transcripts()).toEqual([{ text: "hello world", final: true }])
    expect(sink.done()).toBe(true)
    expect(sink.failed()).toBeUndefined()
  })

  test("each commit is its own POST and its own final chunk, in capture order", async () => {
    stub = sidecar(["first chunk", "second chunk", "the tail"])
    const sink = collector()
    const engine = local(sink.host, stub.url)

    engine.frame(frame(10))
    engine.commit()
    engine.frame(frame(20))
    engine.commit()
    engine.frame(frame(30))
    await engine.stop(16000)

    // One POST per committed chunk, each carrying only that chunk's frames —
    // the transport-level proof that no audio bridges a commit boundary.
    expect(stub.posts()).toEqual([10, 20, 30])
    expect(sink.transcripts()).toEqual([
      { text: "first chunk", final: true },
      { text: "second chunk", final: true },
      { text: "the tail", final: true },
    ])
    expect(sink.done()).toBe(true)
  })

  test("a sidecar that never answers a transcribe fails the dictation", async () => {
    const hung = Bun.serve({
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname === "/health" ? Response.json({ sampleRate: 16000 }) : new Promise(() => {}),
    })
    const url = `http://127.0.0.1:${hung.port}`
    const sink = collector()
    const engine = local(sink.host, url, 50)

    engine.frame(frame(32))
    await engine.stop(16000)
    hung.stop(true)

    expect(sink.failed()).toBe(`Local transcription failed — is the sidecar running at ${url}?`)
  })

  test("a commit with no buffered frames sends no POST", async () => {
    stub = sidecar(["only chunk"])
    const sink = collector()
    const engine = local(sink.host, stub.url)

    engine.commit()
    engine.frame(frame(15))
    await engine.stop(16000)

    expect(stub.posts()).toEqual([15])
    expect(sink.transcripts()).toEqual([{ text: "only chunk", final: true }])
  })

  test("a leading boundary mark from a chunk is trimmed", async () => {
    stub = sidecar([". first", ", second", "..  third"])
    const sink = collector()
    const engine = local(sink.host, stub.url)

    engine.frame(frame(10))
    engine.commit()
    engine.frame(frame(10))
    engine.commit()
    engine.frame(frame(10))
    await engine.stop(16000)

    expect(sink.transcripts()).toEqual([
      { text: "first", final: true },
      { text: "second", final: true },
      { text: "third", final: true },
    ])
  })

  test("an empty transcript emits no chunk but still finalizes", async () => {
    stub = sidecar([""])
    const sink = collector()
    const engine = local(sink.host, stub.url)

    engine.frame(frame(10))
    await engine.stop(16000)

    expect(sink.transcripts()).toEqual([])
    expect(sink.done()).toBe(true)
  })

  test("a sample-rate change fails the dictation and emits nothing", async () => {
    stub = sidecar(["unreachable"], 44100)
    const sink = collector()
    const engine = local(sink.host, stub.url)

    engine.frame(frame(10))
    await engine.stop(16000)

    expect(sink.failed()).toBe("The dictation model changed. Please try again.")
    expect(sink.transcripts()).toEqual([])
    expect(sink.done()).toBe(false)
    expect(stub.posts()).toEqual([])
  })

  test("a transient sidecar failure is retried and the transcript still lands", async () => {
    stub = sidecar(["recovered"], 16000, 2)
    const sink = collector()
    const engine = local(sink.host, stub.url)

    engine.frame(frame(10))
    await engine.stop(16000)

    expect(stub.posts()).toEqual([10])
    expect(sink.transcripts()).toEqual([{ text: "recovered", final: true }])
    expect(sink.done()).toBe(true)
    expect(sink.failed()).toBeUndefined()
  })

  test("a sidecar down for every retry attempt fails the dictation without delivering", async () => {
    stub = sidecar(["never"], 16000, 3)
    const sink = collector()
    const engine = local(sink.host, stub.url)

    engine.frame(frame(10))
    await engine.stop(16000)

    expect(stub.posts()).toEqual([])
    expect(sink.transcripts()).toEqual([])
    expect(sink.failed()).toBe(`Local transcription failed — is the sidecar running at ${stub.url}?`)
    expect(sink.done()).toBe(false)
  })

  test("a 200 reply that is not JSON fails the dictation instead of rejecting stop", async () => {
    stub = sidecar([], 16000, 0, "<html>bad gateway</html>")
    const sink = collector()
    const engine = local(sink.host, stub.url)

    engine.frame(frame(10))
    await engine.stop(16000)

    expect(stub.posts()).toEqual([10])
    expect(sink.transcripts()).toEqual([])
    expect(sink.failed()).toBe(`Local transcription failed — the sidecar at ${stub.url} sent an unreadable reply`)
    expect(sink.done()).toBe(false)
  })

  test("close before stop discards the buffer and emits nothing", async () => {
    stub = sidecar(["never sent"])
    const sink = collector()
    const engine = local(sink.host, stub.url)

    engine.frame(frame(10))
    engine.close()
    await engine.stop(16000)

    expect(stub.posts()).toEqual([])
    expect(sink.transcripts()).toEqual([])
    expect(sink.done()).toBe(false)
  })
})
