import { describe, expect, test } from "bun:test"
import { guard, streaming } from "./fetch"

const never = () => new Promise<Response>(() => {})

function body(chunks: Array<{ after: number; text: string }>) {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        await new Promise((resolve) => setTimeout(resolve, chunk.after))
        controller.enqueue(new TextEncoder().encode(chunk.text))
      }
      controller.close()
    },
  })
}

async function drain(response: Response) {
  const reader = response.body!.getReader()
  let text = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) return text
    text += new TextDecoder().decode(value)
  }
}

describe("streaming", () => {
  test("an sse request is recognised by its accept header", () => {
    const request = new Request("http://x/anything", { headers: { accept: "text/event-stream" } })
    expect(streaming(request)).toBe(true)
  })

  test("an sse request is recognised by its path when the header is absent", () => {
    expect(streaming(new Request("http://x/global/event?connectionID=a"))).toBe(true)
  })

  test("an ordinary request is not streaming", () => {
    expect(streaming(new Request("http://x/session/abc/message"))).toBe(false)
  })

  test("classifies the app's real endpoints correctly", () => {
    expect(streaming(new Request("http://127.0.0.1:4097/global/event?connectionID=abc-123"))).toBe(true)
    expect(
      streaming(
        new Request("http://127.0.0.1:4097/global/event?connectionID=abc", { headers: { "Last-Event-ID": "42" } }),
      ),
    ).toBe(true)
    for (const url of [
      "http://127.0.0.1:4097/global/health",
      "http://127.0.0.1:4097/session/ses_x/message?limit=40",
      "http://127.0.0.1:4097/global/subscribe",
      "http://127.0.0.1:4097/global/recent",
    ]) {
      expect(streaming(new Request(url))).toBe(false)
    }
  })
})

describe("guard", () => {
  // A socket the OS killed silently produces a fetch that neither resolves nor
  // rejects. Every in-flight guard behind it stays latched for the life of the
  // document unless the deadline converts the hang into a rejection.
  test("a request that never answers rejects on the headers deadline", async () => {
    const fetch = guard(never, { headers: 40 })
    await expect(fetch("http://x/session/abc/message")).rejects.toThrow("request timed out")
  })

  test("a body that stops mid-download rejects on the stall deadline", async () => {
    const stalls = async () =>
      new Response(
        body([
          { after: 0, text: "part" },
          { after: 10_000, text: "never" },
        ]),
      )
    const fetch = guard(stalls, { headers: 1000, stall: 40 })
    await expect(drain(await fetch("http://x/session/abc/message"))).rejects.toThrow("response stalled")
  })

  test("a slow but progressing body is never cut off", async () => {
    const slow = async () =>
      new Response(
        body([
          { after: 30, text: "a" },
          { after: 30, text: "b" },
          { after: 30, text: "c" },
        ]),
      )
    const fetch = guard(slow, { headers: 1000, stall: 60 })
    expect(await drain(await fetch("http://x/session/abc/message"))).toBe("abc")
  })

  test("an sse request is exempt from both deadlines", async () => {
    let settled = false
    const stream = () => {
      settled = true
      return never()
    }
    const fetch = guard(stream, { headers: 10, stall: 10 })
    const pending = fetch("http://x/global/event", { headers: { accept: "text/event-stream" } })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(settled).toBe(true)
    await expect(Promise.race([pending, Promise.resolve("pending")])).resolves.toBe("pending")
  })

  test("the caller's own abort still reaches the request", async () => {
    const controller = new AbortController()
    const fetch = guard(never, { headers: 10_000 })
    const pending = fetch("http://x/session/abc/message", { signal: controller.signal })
    controller.abort(new Error("caller cancelled"))
    await expect(pending).rejects.toThrow("caller cancelled")
  })

  test("a normal response passes through untouched", async () => {
    const ok = async () => new Response(body([{ after: 0, text: "hello" }]), { status: 200 })
    const fetch = guard(ok, { headers: 1000, stall: 1000 })
    const response = await fetch("http://x/session/abc/message")
    expect(response.status).toBe(200)
    expect(await drain(response)).toBe("hello")
  })

  // The headers deadline governs time-to-first-byte only, so a download that is
  // still arriving when it elapses is healthy and must be left alone.
  test("a slow download outliving the headers deadline still completes", async () => {
    const slow = async () =>
      new Response(
        body([
          { after: 20, text: "a" },
          { after: 40, text: "b" },
          { after: 40, text: "c" },
        ]),
      )
    const fetch = guard(slow, { headers: 50, stall: 500 })
    expect(await drain(await fetch("http://x/session/abc/message"))).toBe("abc")
  })

  test("a response held before reading is not aborted by the headers deadline", async () => {
    const ok = async () => new Response(body([{ after: 0, text: "hello" }]))
    const fetch = guard(ok, { headers: 40, stall: 5000 })
    const response = await fetch("http://x/session/abc/message")
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(await drain(response)).toBe("hello")
  })

  test("a bodyless response settles without waiting on a stall clock", async () => {
    const empty = async () => new Response(null, { status: 204 })
    const fetch = guard(empty, { headers: 1000, stall: 20 })
    expect((await fetch("http://x/session/abc/message")).status).toBe(204)
  })
})
