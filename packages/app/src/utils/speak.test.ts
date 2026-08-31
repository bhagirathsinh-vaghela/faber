import { describe, expect, test } from "bun:test"
import { sentences, toSpeech } from "./speak"

describe("toSpeech", () => {
  test("a fenced block is named by its language rather than read out", () => {
    const spoken = toSpeech("Here is the fix.\n\n```ts\nconst x = 1\n```\n\nThat is all.").join(" ")
    expect(spoken).toBe("Here is the fix. (ts block) That is all.")
  })

  test("an unlabelled fence is still named", () => {
    expect(toSpeech("Run it.\n\n```\nmake build\n```").join(" ")).toBe("Run it. (code block)")
  })

  test("a table collapses to one word", () => {
    expect(toSpeech("Results:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nDone.")).toEqual([
      "Results:",
      "(table)",
      "Done.",
    ])
  })

  test("a link keeps its text and drops its target", () => {
    expect(toSpeech("See [the docs](https://example.com/x) now.").join(" ")).toBe("See the docs now.")
  })

  test("a bare url is named rather than spelled out", () => {
    expect(toSpeech("Go to https://example.com/a/b now.").join(" ")).toBe("Go to (link) now.")
  })

  test("an image is announced by its alt text", () => {
    expect(toSpeech("![a red square](/img.png) follows.").join(" ")).toBe("image, a red square follows.")
  })

  test("inline marks are dropped but their words survive", () => {
    expect(toSpeech("This is **bold** and `code` and _italic_.").join(" ")).toBe("This is bold and code and italic.")
  })

  test("headings, bullets and quotes lose their markers", () => {
    expect(toSpeech("# Title\n\n- one\n- two\n\n> quoted")).toEqual(["Title", "one", "two", "quoted"])
  })

  test("prose splits on sentence boundaries", () => {
    expect(toSpeech("One. Two. Three.")).toEqual(["One. Two. Three."])
  })

  test("a sentence longer than the cap splits on whitespace without cutting a word", () => {
    const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ")
    const parts = toSpeech(long)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.join(" ")).toBe(long)
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(600)
  })

  test("a decimal point is not treated as the end of a sentence", () => {
    expect(sentences("It fetched 39.5s of audio up front.")).toEqual(["It fetched 39.5s of audio up front."])
  })

  test("a dotted version number stays one sentence", () => {
    expect(sentences("Version 1.2.3 shipped.")).toEqual(["Version 1.2.3 shipped."])
  })

  test("ordinary sentences still separate", () => {
    expect(sentences("One. Two.").length).toBe(2)
  })

  // A chunk is only ever cut mid-sentence when one sentence alone exceeds the
  // cap, and that cut is heard as the speech stopping short. The cap therefore
  // has to clear the long sentences real prose contains, not just average ones.
  test("a long but ordinary sentence is spoken whole rather than cut mid-clause", () => {
    const source =
      "I created a new Audio element per chunk, and iOS grants playback only to the element a gesture touched, so chunk one slipped through while every later element was refused."
    expect(toSpeech(source)).toEqual([source])
  })

  test("a message that is only a code block yields nothing to read", () => {
    expect(toSpeech("```\njust code\n```")).toEqual(["(code block)"])
  })

  test("empty input yields no chunks", () => {
    expect(toSpeech("   \n\n  ")).toEqual([])
  })

  test("no prose word is lost between the source and what is spoken", () => {
    const source = "First sentence here. Second one follows it. A third closes the paragraph."
    expect(toSpeech(source).join(" ")).toBe(source)
  })
})
