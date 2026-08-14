import { describe, expect, test } from "bun:test"
import { ABORTED, settled } from "../../src/util/abort"

// A tool that ignores its abort signal leaves the AI SDK's stream suspended:
// no further chunk, no end, no throw. The processor's drain must still finish,
// because the teardown that marks unfinished tool parts as errored sits after
// it. Anything that waits on the iterator alone parks forever and never
// reaches that teardown, which is what leaves a part spinning for the life of
// the session.
//
// The stream below never yields again after the tool call and never closes, so
// a drain lacking the abort race hangs here instead of failing an assertion.
function suspended() {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "tool-call", toolCallId: "call-1" }
      await new Promise<never>(() => {})
    },
  }
}

async function drain(stream: ReturnType<typeof suspended>, signal: AbortSignal) {
  const parts: Record<string, string> = {}
  const iterator = stream[Symbol.asyncIterator]()
  const aborted = settled(signal)
  while (true) {
    const step = await Promise.race([iterator.next(), aborted])
    if (step === ABORTED) {
      void iterator.return?.().catch(() => {})
      break
    }
    if (step.done) break
    if (step.value.type === "tool-call") parts[step.value.toolCallId] = "running"
  }
  for (const [callID, status] of Object.entries(parts)) {
    if (status !== "completed" && status !== "error") parts[callID] = "error"
  }
  return parts
}

describe("session.processor abort drain", () => {
  test("a tool that never settles still reaches the part teardown", async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)

    const parts = await drain(suspended(), controller.signal)

    expect(parts).toEqual({ "call-1": "error" })
  })

  test("an already-aborted signal ends the drain before the first chunk", async () => {
    const parts = await drain(suspended(), AbortSignal.abort())

    expect(parts).toEqual({})
  })

  test("settled resolves with ABORTED and never rejects", async () => {
    const controller = new AbortController()
    const promise = settled(controller.signal)
    controller.abort(new Error("stop"))

    expect(await promise).toBe(ABORTED)
  })
})
