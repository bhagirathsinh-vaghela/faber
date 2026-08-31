import { describe, expect, test } from "bun:test"
import { accept, lead, toSpeech } from "./speak"

describe("lead", () => {
  test("a long first chunk is shortened so the first sound arrives quickly", () => {
    expect(lead(toSpeech("One two three. " + "Filler sentence here. ".repeat(12)))[0]!.length).toBeLessThanOrEqual(90)
  })

  test("no words are lost when the first chunk is split", () => {
    const before = toSpeech("A single unbroken sentence that runs well past the opening character budget without stopping.")
    expect(lead(before).join(" ")).toBe(before.join(" "))
  })

  test("the split lands on a word boundary rather than mid-word", () => {
    const chunks = lead(
      toSpeech("A single unbroken sentence that runs well past the opening character budget without stopping."),
    )
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]!.endsWith(" ")).toBe(false)
    expect(chunks[1]!.startsWith(" ")).toBe(false)
  })

  test("a first chunk already short enough is left alone", () => {
    const before = toSpeech("Just this.")
    expect(lead(before)).toEqual(before)
  })

  test("later chunks are never touched, however long they are", () => {
    const before = toSpeech("Short one. " + "A considerably longer following sentence that fills its chunk. ".repeat(3))
    const after = lead(before)
    // Only the first chunk may gain a sibling, so the tail is compared from the
    // end rather than by a fixed offset.
    expect(after.slice(after.length - (before.length - 1))).toEqual(before.slice(1))
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

  test("a browser that cannot decode Opus falls back to mp4", () => {
    expect(accept(probe(""))).toBe("audio/mp4")
  })
})
