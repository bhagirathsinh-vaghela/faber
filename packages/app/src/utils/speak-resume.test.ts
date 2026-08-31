import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createSpeech } from "./speak"

// A position outlives any one reading, keyed by the message text, so a test
// reusing another's text would inherit where that one left off.
let seq = 0
const message = () =>
  Array.from(
    { length: 6 },
    (_, i) =>
      `Message ${++seq} sentence ${i} carries enough prose of its own to fill a chunk, since the cap packs short ` +
      `sentences together and these tests need one chunk per sentence to navigate between.`,
  ).join("\n\n")

// A never-heard message plays immediately, so the element has to survive the
// call even though no audio is fetched in these tests.
function speech() {
  Object.defineProperty(window, "Audio", {
    configurable: true,
    value: class {
      play = () => Promise.resolve()
      pause = () => {}
      load = () => {}
      removeAttribute = () => {}
      preservesPitch = true
      playbackRate = 1
      src = ""
    },
  })
  return createSpeech({ url: () => "" })
}

describe("createSpeech position", () => {
  test("a message never heard before begins at its first chunk", () => {
    createRoot((dispose) => {
      const it = speech()
      const LONG = message()
      it.show(LONG)
      expect(it.open()).toBe(true)
      expect(it.index()).toBe(0)
      expect(it.total()).toBeGreaterThan(1)
      dispose()
    })
  })

  test("a message opened again resumes where it was left", () => {
    createRoot((dispose) => {
      const it = speech()
      const LONG = message()
      it.show(LONG)
      it.next()
      it.next()
      expect(it.index()).toBe(2)
      it.close()
      it.show(LONG)
      expect(it.index()).toBe(2)
      dispose()
    })
  })

  test("a different message starts at its own beginning", () => {
    createRoot((dispose) => {
      const it = speech()
      const LONG = message()
      it.show(LONG)
      it.next()
      it.show("A different message entirely. With its own two sentences.")
      expect(it.index()).toBe(0)
      dispose()
    })
  })

  test("each message keeps its own place, not just the last one read", () => {
    const other = message()
    createRoot((dispose) => {
      const it = speech()
      const LONG = message()
      it.show(LONG)
      it.next()
      it.next()
      it.show(other)
      it.next()
      expect(it.index()).toBe(1)
      it.show(LONG)
      expect(it.index()).toBe(2)
      dispose()
    })
  })

  test("returning to the first chunk clears the resume offer", () => {
    createRoot((dispose) => {
      const it = speech()
      const LONG = message()
      it.show(LONG)
      it.next()
      it.next()
      it.seek(0)
      expect(it.index()).toBe(0)
      expect(it.resuming()).toBe(false)
      dispose()
    })
  })

  test("seeking never leaves the queue", () => {
    createRoot((dispose) => {
      const it = speech()
      const LONG = message()
      it.show(LONG)
      it.previous()
      expect(it.index()).toBe(0)
      it.seek(999)
      expect(it.index()).toBe(it.total() - 1)
      dispose()
    })
  })

  test("navigating leaves playback stopped, so nothing plays unasked", () => {
    createRoot((dispose) => {
      const it = speech()
      const LONG = message()
      it.show(LONG)
      it.next()
      expect(it.speaking()).toBe(false)
      expect(it.armed()).toBe(true)
      it.previous()
      expect(it.speaking()).toBe(false)
      dispose()
    })
  })

  test("a message with a remembered place waits rather than resuming on its own", () => {
    createRoot((dispose) => {
      const it = speech()
      const LONG = message()
      it.show(LONG)
      it.next()
      it.close()
      it.show(LONG)
      expect(it.index()).toBe(1)
      expect(it.speaking()).toBe(false)
      expect(it.armed()).toBe(true)
      dispose()
    })
  })

  test("closing the HUD leaves nothing shown", () => {
    createRoot((dispose) => {
      const it = speech()
      const LONG = message()
      it.show(LONG)
      it.close()
      expect(it.open()).toBe(false)
      expect(it.chunk()).toBe("")
      dispose()
    })
  })
})
