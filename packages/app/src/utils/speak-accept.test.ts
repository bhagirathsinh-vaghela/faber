import { describe, expect, test } from "bun:test"
import { accept, toSpeech } from "./speak"

describe("chunk pacing", () => {
  const prose = (count: number) =>
    Array.from(
      { length: count },
      (_, at) => `Sentence number ${at} carries enough words to be a realistic unit of spoken prose here.`,
    ).join(" ")

  // Every chunk but the last is rendered while the one before it plays, so its
  // length is bounded by that chunk's. The last is exempt, since nothing waits
  // on it. The absolute allowance covers sentence quantization: at a few dozen
  // characters a single word swings the ratio, while the audio either side is
  // under a second and the wait it could cause is not audible.
  const paced = (chunks: string[]) => {
    for (let at = 1; at < chunks.length - 1; at++) {
      expect(chunks[at]!.length).toBeLessThanOrEqual(chunks[at - 1]!.length * 2.05 + 20)
    }
  }

  test("the first chunk is short enough to arrive quickly", () => {
    expect(toSpeech(prose(40))[0]!.length).toBeLessThanOrEqual(90)
  })

  test("no chunk outgrows the cover the one before it provides", () => {
    const chunks = toSpeech(prose(40))
    expect(chunks.length).toBeGreaterThan(4)
    paced(chunks)
  })

  test("chunks reach full length rather than staying short for the whole reading", () => {
    expect(Math.max(...toSpeech(prose(60)).map((chunk) => chunk.length))).toBeGreaterThan(300)
  })

  test("no chunk exceeds the cap", () => {
    for (const chunk of toSpeech(prose(60))) expect(chunk.length).toBeLessThanOrEqual(600)
  })

  test("a short message is still one chunk", () => {
    expect(toSpeech("Just this.")).toEqual(["Just this."])
  })

  test("the ramp carries across a code block rather than restarting after it", () => {
    const chunks = toSpeech(prose(10) + "\n\n```ts\nconst x = 1\n```\n\n" + prose(20))
    const code = chunks.findIndex((chunk) => chunk.startsWith("Code block."))
    expect(code).toBeGreaterThan(-1)
    expect(chunks[code + 1]!.length).toBeGreaterThan(90)
  })

  // Short sentences leave every chunk well under its cap, so a cap that rises
  // on its own outruns the audio actually being bought.
  test("a run of short sentences does not license a long chunk after them", () => {
    paced(toSpeech("Short one here. ".repeat(8) + prose(12)))
  })

  // Filling each piece of an oversized sentence to the cap leaves the remainder
  // as a tail too short to cover what follows it.
  test("splitting an oversized sentence leaves no piece far shorter than its siblings", () => {
    const chunks = toSpeech(prose(6) + ` The measurement ${"runs on and on without any terminator ".repeat(20)}here.`)
    paced(chunks)
    for (let at = 1; at < chunks.length - 1; at++) {
      expect(chunks[at]!.length).toBeGreaterThanOrEqual(chunks[at - 1]!.length * 0.7)
    }
  })
})

// Codec negotiation decides how many bytes cross a cellular link, so it is
// pinned rather than left to whatever the server would otherwise default to.
describe("accept", () => {
  const probe = (ogg: string) => ({ canPlayType: (type: string) => (type.includes("ogg") ? ogg : "maybe") }) as HTMLAudioElement

  test("a browser that decodes Ogg Opus asks for it", () => {
    expect(accept(probe("probably"))).toBe("audio/ogg")
  })

  test("a hesitant 'maybe' still counts as support", () => {
    expect(accept(probe("maybe"))).toBe("audio/ogg")
  })

  test("a browser that cannot decode Opus falls back to WAV", () => {
    expect(accept(probe(""))).toBe("audio/wav")
  })
})
